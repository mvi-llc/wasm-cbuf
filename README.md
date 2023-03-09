# wasm-cbuf

> Verdant CBUF IDL and message serialization compiled to WebAssembly.

## What is this?

[Verdant Robotics](https://www.verdantrobotics.com/) robots use an Interface Definition Language and message serialization format called "cbuf". This is similar to other IDLs such as Google Protobufs, FlatBuffers, Cap'n'Proto, DDS IDL+CDR, ROS message definitions, etc. It optimizes for matching on-wire and in-memory representations where possible, and the definition language is a lightweight syntax geared toward C/C++ code generation.

This library provides a WebAssembly build of cbuf wrapped in a TypeScript/JavaScript API for parsing `.cbuf` message definitions and deserializing cbuf payloads.

## Usage

Here's an example of parsing a `.cbuf` schema. Note that this does not handle `#include` statements; you must replace all includes with the contents of the included file before calling this method.

```ts
import Cbuf from "wasm-cbuf"

async function main() {
  await Cbuf.isLoaded

  const result = Cbuf.parseCBufSchema(`struct vec2 { float x; float y; }`)
  console.dir(result)
  /**
    {
      schema: [
        {
          name: 'vec2',
          hashValue: 6141859528966909963n,
          line: 1,
          column: 13,
          naked: false,
          simple: true,
          hasCompact: false,
          definitions: [
            { name: 'x', type: 'float32' },
            { name: 'y', type: 'float32' }
          ]
        }
      ]
    }
  */
}

main()
```

## Development

You will need node.js >= 16.x, the `yarn` package manager, and Docker installed.

1. `yarn install`
2. `yarn build`
3. `yarn test`

## License

wasm-cbuf is licensed under the [Apache-2.0 License](https://opensource.org/license/apache-2-0/).

## Releasing

1. Run `yarn version --[major|minor|patch]` to bump version
2. Run `git push && git push --tags` to push new tag
3. GitHub Actions will take care of the rest
