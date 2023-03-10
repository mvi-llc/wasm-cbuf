import { MessageDefinition } from "@foxglove/message-definition"

declare module "wasm-cbuf" {
  export type CbufMessageDefinition = MessageDefinition & {
    hashValue: BigInt
    line: number
    column: number
    naked: boolean
    simple: boolean
    hasCompact: boolean
  }

  export type CbufMessageMap = Map<string, CbufMessageDefinition>
  export type CbufHashMap = Map<BigInt, CbufMessageDefinition>

  type Cbuf = {
    isLoaded: Promise<void>
    parseCBufSchema: (schemaText: string) => { error?: string; schema: CbufMessageMap }
    schemaMapToHashMap: (schemaMap: CbufMessageMap) => CbufHashMap
    deserializeMessage: (
      hashMap: CbufHashMap,
      data: Uint8Array,
      offset?: number,
    ) => {
      typeName: string
      size: number
      hashValue: BigInt
      timestamp: number
      message: Record<string, unknown>
    }
  }

  const cbuf: Cbuf
  export default cbuf
}
