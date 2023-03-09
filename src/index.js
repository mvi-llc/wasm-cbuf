const ModuleFactory = require("./wasm-cbuf")
const ModulePromise = ModuleFactory()

let Module

function ensureLoaded() {
  if (!Module) {
    throw new Error(`wasm-cbuf has not finished loading. Please wait with "await Cbuf.isLoaded"`)
  }
}

module.exports.parseCBufSchema = function parseCBufSchema(schema) {
  ensureLoaded()
  return Module.parseCBufSchema(schema)
}

/**
 * A promise a consumer can listen to, to wait for the module to finish loading.
 * module loading is async and can take several hundred milliseconds. Accessing
 * the module before it is loaded will throw an error.
 * @type {Promise<void>}
 */
module.exports.isLoaded = ModulePromise.then((mod) => mod["ready"].then(() => {}))

// Wait for the promise returned from ModuleFactory to resolve
ModulePromise.then((mod) => {
  Module = mod

  // export the Module object for testing purposes _only_
  if (typeof process === "object" && process.env.NODE_ENV === "test") {
    module.exports.__module = Module
  }
})
