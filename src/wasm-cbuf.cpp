#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstring>
#include <string>

#include "SchemaParser.h"
#include "ast.h"

using emscripten::val;

int main(int argc, char** argv) {}

val MakeError(const std::string& error) {
  val obj = val::object();
  obj.set("error", error);
  obj.set("schema", val::array());
  return obj;
}

void parseNamespace(const ast_namespace* ns, val& array) {
  std::string nsName = ns->name != nullptr ? std::string{ns->name} : "";
  if (nsName == GLOBAL_NAMESPACE) {
    nsName = "";
  }

  // Iterate each struct in this namespace
  for (const ast_struct* st : ns->structs) {
    std::string name = nsName.empty() ? std::string{st->name} : nsName + "::" + st->name;
    val entry = val::object();
    entry.set("name", name);
    entry.set("hashValue", st->hash_value);
    entry.set("line", st->loc.line);
    entry.set("column", st->loc.col);
    entry.set("naked", st->naked);
    entry.set("simple", st->simple);
    entry.set("hasCompact", st->has_compact);

    // Extract field definitions for this struct
    val definitions = val::array();
    for (const ast_element* elem : st->elements) {
      val def = val::object();
      def.set("name", elem->name != nullptr ? elem->name : "");
      def.set("type", SchemaParser::TypeName(elem));

      // Default value handling
      if (elem->init_value) {
        switch (elem->type) {
          case TYPE_U8:
          case TYPE_U16:
          case TYPE_U32:
            def.set("defaultValue", uint32_t(elem->init_value->int_val));
            break;
          case TYPE_S8:
          case TYPE_S16:
          case TYPE_S32:
            def.set("defaultValue", int32_t(elem->init_value->int_val));
            break;
          case TYPE_U64:
          case TYPE_S64:
            def.set("defaultValue", elem->init_value->int_val);
            break;
          case TYPE_F32:
          case TYPE_F64:
            def.set("defaultValue", elem->init_value->float_val);
            break;
          case TYPE_STRING:
          case TYPE_SHORT_STRING:
            def.set("defaultValue", std::string{elem->init_value->str_val});
            break;
          case TYPE_BOOL:
            def.set("defaultValue", elem->init_value->bool_val);
            break;
          case TYPE_CUSTOM:
            // Custom type default values are not supported
            break;
        }
      }

      // Short strings have a fixed upper bound
      if (elem->type == TYPE_SHORT_STRING) {
        def.set("upperBound", elem->csize);
      }

      // Array handling
      if (elem->array_suffix) {
        def.set("isArray", true);
        if (!elem->is_dynamic_array) {
          if (elem->is_compact_array) {
            def.set("arrayUpperBound", int(elem->array_suffix->size));
          } else {
            def.set("arrayLength", int(elem->array_suffix->size));
          }
        }
      }

      definitions.call<void>("push", def);
    }
    entry.set("definitions", definitions);

    array.call<void>("push", entry);
  }
}

val parseCBufSchema(val schema) {
  std::string schemaStr = schema.as<std::string>();
  // Ensure schemaStr ends with a newline. The parser will fail otherwise
  if (schemaStr.back() != '\n') {
    schemaStr += '\n';
  }

  SchemaParser parser;
  if (!parser.ParseMetadata(schemaStr, "")) {
    const auto& error = parser.lastError();
    return MakeError(error.empty() ? "Schema parsing failed" : error);
  }

  ast_global* ast = parser.parsedAst();
  if (ast == nullptr) {
    const auto& error = parser.lastError();
    return MakeError(error.empty() ? "No AST after schema parsing" : error);
  }

  if (!parser.computeHashes(ast)) {
    const auto& error = parser.lastError();
    return MakeError(error.empty() ? "Failed to compute hashes" : error);
  }

  val array = val::array();

  // Iterate each namespace
  parseNamespace(&ast->global_space, array);
  for (const ast_namespace* ns : ast->spaces) {
    parseNamespace(ns, array);
  }

  val ret = val::object();
  ret.set("schema", array);
  return ret;
}

EMSCRIPTEN_BINDINGS(cbuf) {
  emscripten::function("parseCBufSchema", &parseCBufSchema);
}
