import { MessageDefinition } from "@foxglove/message-definition"

declare module "wasm-cbuf" {
  export type CbufMessageDefinition = MessageDefinition & {
    /** The hash value of the `.cbuf` message definition */
    hashValue: bigint
    /** Line number of the beginning of the struct definition */
    line: number
    /** Column number of the beginning of the struct definition */
    column: number
    /** If true, this struct is not prefixed with a cbuf message header */
    naked: boolean
  }

  export type CbufTypedArray =
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array

  export type CbufValue =
    | boolean
    | number
    | bigint
    | string
    | CbufTypedArray
    | CbufValue[]
    | Record<string, CbufValue>

  export type CbufMessage = {
    /** The fully qualified message name */
    typeName: string
    /** The size of the message header and message data, in bytes */
    size: number
    /** The message variant, for distinguishing multiple publishers of the same message type */
    variant: number
    /** The hash value of the `.cbuf` message definition */
    hashValue: bigint
    /** A timestamp in seconds since the Unix epoch as a 64-bit float */
    timestamp: number
    /** The deserialized messge data */
    message: Record<string, CbufValue>
  }

  export type CbufMessageMap = Map<string, CbufMessageDefinition>
  export type CbufHashMap = Map<bigint, CbufMessageDefinition>

  type Cbuf = {
    /** A promise that completes when the wasm module is loaded and ready */
    isLoaded: Promise<void>
    /**
     * Parse a CBuf `.cbuf` schema into an object containing an error string or a
     * `Map<string, MessageDefinition>`.
     *
     * @param schemaText The schema text to parse. This is the contents of a `.cbuf` file where
     *   all #include statements have been expanded.
     * @returns An object containing the parsed schema as a Map<string, MessageDefinition> mapping
     *   fully qualified message names to their parsed definition, or an error string if parsing
     *   failed.
     */
    parseCBufSchema: (schemaText: string) => { error?: string; schema: CbufMessageMap }
    /**
     * Takes a parsed schema (`Map<string, MessageDefinition>`) which maps message names to message
     * definitions and returns a new `Map<bigint, MessageDefinition>` mapping hash values to message
     * definitions.
     *
     * @returns Mapping from hash values to message definitions.
     */
    schemaMapToHashMap: (schemaMap: CbufMessageMap) => CbufHashMap
    /**
     * Given a schema map and hash map, a byte buffer, and optional offset into the buffer,
     * deserialize the buffer into a JavaScript object representing a single non-naked struct
     * message, which includes a message header and message data.
     *
     * @param schemaMap A map of fully qualified message names to message definitions obtained from
     *   `parseCBufSchema()`.
     * @param hashMap A map of hash values to message definitions obtained `schemaMapToHashMap()`.
     * @param data The byte buffer to deserialize from.
     * @param offset Optional byte offset into the buffer to deserialize from.
     * @returns A JavaScript object representing the deserialized message header fields and message
     *   data.
     */
    deserializeMessage: (
      schemaMap: CbufMessageMap,
      hashMap: CbufHashMap,
      data: ArrayBufferView,
      offset?: number,
    ) => CbufMessage
    /**
     * Given a schema map and hash map, and a `CbufMessage` object, serialize the message into a
     * byte buffer.
     *
     * @param schemaMap A map of fully qualified message names to message definitions obtained from
     *   `parseCBufSchema()`.
     * @param hashMap A map of hash values to message definitions obtained `schemaMapToHashMap()`.
     * @param message
     * @returns A byte buffer containing the serialized message header and message data.
     */
    serializeMessage: (
      schemaMap: CbufMessageMap,
      hashMap: CbufHashMap,
      message: CbufMessage,
    ) => ArrayBuffer
    /**
     * Given a schema map and hash map, and a `CbufMessage` object, return the size of the
     * serialized message in bytes.
     *
     * @param schemaMap A map of fully qualified message names to message definitions obtained from
     *   `parseCBufSchema()`.
     * @param hashMap A map of hash values to message definitions obtained `schemaMapToHashMap()`.
     * @param message
     * @returns The size of the serialized message in bytes.
     */
    serializedMessageSize: (
      schemaMap: CbufMessageMap,
      hashMap: CbufHashMap,
      message: CbufMessage,
    ) => number
  }

  const cbuf: Cbuf
  export default cbuf
}
