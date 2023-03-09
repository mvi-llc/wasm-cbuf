#!/usr/bin/env bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $SCRIPT_DIR

docker build . -t wasm-cbuf

mkdir -p dist

docker run --rm -v "${SCRIPT_DIR}/dist":/wasm-cbuf/dist -t wasm-cbuf ./build.sh
