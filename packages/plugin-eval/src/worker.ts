import { Logger, escapeRegExp, observe, difference } from 'koishi-utils'
import { parentPort, workerData } from 'worker_threads'
import { InspectOptions, formatWithOptions } from 'util'
import { findSourceMap } from 'module'
import { dirname, sep } from 'path'

/* eslint-disable import/first */

// time diff is not displayed because timestamp will not be synchronized between main thread and worker thread
Logger.levels = workerData.logLevels
Logger.showTime = workerData.logTime
const logger = new Logger('eval')

import { expose, wrap } from './transfer'
import { VM } from './vm'
import { MainAPI } from '.'
import { Channel, User } from 'koishi-core'

export interface WorkerConfig {
  setupFiles?: Record<string, string>
  inspect?: InspectOptions
}

export interface WorkerData extends WorkerConfig {}

export const config: WorkerData = {
  ...workerData,
  inspect: {
    depth: 0,
    ...workerData.inspect,
  },
}

interface EvalOptions {
  silent: boolean
  source: string
}

const vm = new VM()
export const context = vm.context
export const internal = vm.internal
export const sandbox = internal.sandbox

const pathMapper: Record<string, RegExp> = {}

function formatResult(...param: [string, ...any[]]) {
  return formatWithOptions(config.inspect, ...param)
}

export function formatError(error: Error) {
  if (!(error instanceof Error)) return `Uncaught: ${error}`

  return error.stack
    .replace(/\s*.+(Script|MessagePort)[\s\S]*/, '')
    .split('\n')
    .map((line) => {
      for (const name in pathMapper) {
        line = line.replace(pathMapper[name], '$1' + name)
      }
      return line
    })
    .join('\n')
}

const main = wrap<MainAPI>(parentPort)

export interface ContextOptions {
  $uuid: string
  user: Partial<User>
  channel: Partial<Channel>
  userWritable: User.Field[]
  channelWritable: Channel.Field[]
}

export interface Context {
  user: User.Observed<any>
  channel: Channel.Observed<any>
  send(...param: any[]): Promise<void>
  exec(message: string): Promise<string>
}

export const Context = ({ $uuid, user, userWritable, channel, channelWritable }: ContextOptions): Context => ({
  user: user && observe(user, async (diff) => {
    const diffKeys = difference(Object.keys(diff), userWritable)
    if (diffKeys.length) {
      throw new TypeError(`cannot set user field: ${diffKeys.join(', ')}`)
    }
    await main.updateUser($uuid, diff)
  }),

  channel: channel && observe(channel, async (diff) => {
    const diffKeys = difference(Object.keys(diff), channelWritable)
    if (diffKeys.length) {
      throw new TypeError(`cannot set group field: ${diffKeys.join(', ')}`)
    }
    await main.updateGroup($uuid, diff)
  }),

  async send(...param: [string, ...any[]]) {
    return await main.send($uuid, formatResult(...param))
  },

  async exec(message: string) {
    if (typeof message !== 'string') {
      throw new TypeError('The "message" argument must be of type string')
    }
    return await main.execute($uuid, message)
  },
})

export interface Response {}

export const response: Response = {}

export class WorkerAPI {
  start() {
    return response
  }

  async sync(ctx: Context) {
    await ctx.user?._update()
    await ctx.channel?._update()
  }

  async eval(ctxOptions: ContextOptions, evalOptions: EvalOptions) {
    const { source, silent } = evalOptions

    const key = 'koishi-eval-context:' + ctxOptions.$uuid
    const ctx = Context(ctxOptions)
    internal.setGlobal(Symbol.for(key), ctx, true)

    let result: any
    try {
      result = await vm.run(`with (global[Symbol.for("${key}")]) {
        delete global[Symbol.for("${key}")];\n${source}
      }`, {
        filename: 'stdin',
        lineOffset: -2,
      })
      await this.sync(ctx)
    } catch (error) {
      return formatError(error)
    }

    if (result === undefined || silent) return
    return formatResult(result)
  }
}

export function mapDirectory(identifier: string, filename: string) {
  const sourceMap = findSourceMap(filename)
  if (!sourceMap) return logger.warn('cannot find source map for %c', filename)
  const path = dirname(sourceMap.payload.sources[0].slice(7)) + sep
  pathMapper[identifier] = new RegExp(`(at | \\()${escapeRegExp(path)}`, 'g')
}

Promise.all(Object.values(config.setupFiles).map(file => require(file).default)).then(() => {
  mapDirectory('koishi/', __filename)
  Object.entries(config.setupFiles).forEach(([name, path]) => {
    const sourceMap = findSourceMap(path)
    if (sourceMap) path = sourceMap.payload.sources[0].slice(7)
    return pathMapper[name] = new RegExp(`(at | \\()${escapeRegExp(path)}`, 'g')
  })
}, logger.warn).then(() => {
  expose(parentPort, new WorkerAPI())
})
