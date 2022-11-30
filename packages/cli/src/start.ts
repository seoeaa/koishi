import { Dict, hyphenate, isInteger } from '@koishijs/utils'
import { ChildProcess, fork } from 'child_process'
import { resolve } from 'path'
import { CAC } from 'cac'
import type { Config, Event } from './worker/daemon'
import kleur from 'kleur'

let child: ChildProcess
let buffer = null

function toArg(key: string) {
  return key.length === 1 ? `-${key}` : `--${hyphenate(key)}`
}

function createWorker(options: Dict<any>) {
  const execArgv = Object.entries(options).flatMap<string>(([key, value]) => {
    if (key === '--') return []
    key = toArg(key)
    if (value === true) {
      return [key]
    } else if (value === false) {
      return ['--no-' + key.slice(2)]
    } else if (Array.isArray(value)) {
      return value.flatMap(value => [key, value])
    } else {
      return [key, value]
    }
  })
  execArgv.push(...options['--'])

  child = fork(resolve(__dirname, 'worker'), [], {
    execArgv,
  })

  let config: Config
  let timer: NodeJS.Timeout

  child.on('message', (message: Event) => {
    if (message.type === 'start') {
      config = message.body
      timer = config.heartbeatTimeout && setTimeout(() => {
        console.log(kleur.red('daemon: heartbeat timeout'))
        child.kill('SIGKILL')
      }, config.heartbeatTimeout)
      if (buffer) {
        child.send({ type: 'send', body: buffer })
        buffer = null
      }
    } else if (message.type === 'exit') {
      buffer = message.body
    } else if (message.type === 'heartbeat') {
      if (timer) timer.refresh()
    }
  })

  /**
   * https://tldp.org/LDP/abs/html/exitcodes.html
   * - 0: exit manually
   * - 51: restart (magic code)
   * - 130: SIGINT
   * - 137: SIGKILL (timeout)
   * - 143: SIGTERM
   */
  const closingCode = [0, 130, 143]

  child.on('exit', (code) => {
    if (!config || closingCode.includes(code) || code !== 51 && !config.autoRestart) {
      process.exit(code)
    }
    createWorker(options)
  })
}

function setEnvArg(name: string, value: string | boolean) {
  if (value === true) {
    process.env[name] = ''
  } else if (value) {
    process.env[name] = value
  }
}

export default function (cli: CAC) {
  cli.command('start [file]', 'start a koishi bot')
    .alias('run')
    .allowUnknownOptions()
    .option('--debug [namespace]', 'specify debug namespace')
    .option('--log-level [level]', 'specify log level (default: 2)')
    .option('--log-time [format]', 'show timestamp in logs')
    .option('--watch [path]', 'watch and reload at change')
    .action((file, options) => {
      const { logLevel, debug, logTime, watch, ...rest } = options
      if (logLevel !== undefined && (!isInteger(logLevel) || logLevel < 0)) {
        console.warn(`${kleur.red('error')} log level should be a positive integer.`)
        process.exit(1)
      }
      setEnvArg('KOISHI_WATCH_ROOT', watch)
      setEnvArg('KOISHI_LOG_TIME', logTime)
      process.env.KOISHI_LOG_LEVEL = logLevel || ''
      process.env.KOISHI_DEBUG = debug || ''
      process.env.KOISHI_CONFIG_FILE = file || ''
      createWorker(rest)
    })
}
