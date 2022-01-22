import { resolve, extname, dirname, isAbsolute } from 'path'
import { yellow } from 'kleur'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { App, Dict, Logger, Modules, Plugin, Schema } from 'koishi'
import { dump, load } from 'js-yaml'

declare module 'koishi' {
  namespace Context {
    interface Services {
      loader: Loader
    }
  }
}

const oldPaths = Modules.internal.paths
Modules.internal.paths = function (name: string) {
  // resolve absolute or relative path
  if (isAbsolute(name) || name.startsWith('.')) {
    return [resolve(cwd, name)]
  }
  return oldPaths(name)
}

App.Config.list.push(Schema.object({
  allowWrite: Schema.boolean().description('允许在运行时修改配置文件。').default(true),
  autoRestart: Schema.boolean().description('应用在运行时崩溃自动重启。').default(true),
  plugins: Schema.any().hidden(),
}).description('CLI 设置'))

let cwd = process.cwd()
const logger = new Logger('app')

export class Loader {
  dirname: string
  filename: string
  extname: string
  app: App
  config: App.Config
  cache: Dict<Plugin> = {}

  constructor() {
    const basename = 'koishi.config'
    if (process.env.KOISHI_CONFIG_FILE) {
      this.filename = resolve(cwd, process.env.KOISHI_CONFIG_FILE)
      this.extname = extname(this.filename)
      this.dirname = cwd = dirname(this.filename)
    } else {
      const files = readdirSync(cwd)
      this.extname = ['.js', '.json', '.ts', '.coffee', '.yaml', '.yml'].find(ext => files.includes(basename + ext))
      if (!this.extname) {
        throw new Error(`config file not found. use ${yellow('koishi init')} command to initialize a config file.`)
      }
      this.dirname = cwd
      this.filename = cwd + '/' + basename + this.extname
    }
  }

  loadConfig(): App.Config {
    if (['.yaml', '.yml'].includes(this.extname)) {
      return this.config = load(readFileSync(this.filename, 'utf8')) as any
    } else if (['.json'].includes(this.extname)) {
      // we do not use require here because it will pollute require.cache
      return this.config = JSON.parse(readFileSync(this.filename, 'utf8')) as any
    } else {
      const module = require(this.filename)
      return this.config = module.default || module
    }
  }

  resolvePlugin(name: string) {
    const path = Modules.resolve(name)
    return this.cache[path] = Modules.require(name, true)
  }

  loadPlugin(name: string, options?: any) {
    const plugin = this.resolvePlugin(name)
    if (this.app.registry.has(plugin)) return plugin
    this.app.plugin(plugin, options)
    return plugin
  }

  writeConfig() {
    // prevent hot reload when it's being written
    if (this.app.watcher) this.app.watcher.suspend = true
    if (this.extname === '.json') {
      writeFileSync(this.filename, JSON.stringify(this.config, null, 2))
    } else {
      writeFileSync(this.filename, dump(this.config))
    }
  }

  createApp() {
    const app = this.app = new App(this.config)
    app.loader = this
    app.baseDir = this.dirname
    const plugins = app.options.plugins ||= {}
    for (const name in plugins) {
      if (name.startsWith('~')) {
        this.resolvePlugin(name.slice(1))
      } else {
        logger.info(`apply plugin %c`, name)
        this.loadPlugin(name, plugins[name] ?? {})
      }
    }
    if (!['.json', '.yaml', '.yml'].includes(this.extname)) {
      app.options.allowWrite = false
    }
    return app
  }
}
