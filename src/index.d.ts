import { MessageDefinition } from "@foxglove/message-definition"

declare module "wasm-cbuf" {
  type Cbuf = {
    isLoaded: Promise<void>
    parseCBufSchema: (schema: string) => { error?: string; schema: MessageDefinition[] }
  }
}
