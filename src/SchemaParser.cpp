#include "SchemaParser.h"

#include <cstdint>

#include "Interp.h"
#include "StdStringBuffer.h"
#include "SymbolTable.h"

// clang-format off
static const char* ElementTypeToStrC[] = {
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "int8_t",
  "int16_t",
  "int32_t",
  "int64_t",
  "float",
  "double",
  "std::string",
  "VString<15>",
  "bool"
};
// clang-format on

uint64_t hash(const unsigned char* str) {
  uint64_t hash = 5381;
  int c;

  while ((c = *str++)) hash = ((hash << 5) + hash) + c;

  return hash;
}

bool ComputeHash(ast_struct* st, SymbolTable* symtable, Interp* interp) {
  StdStringBuffer buf;
  if (st->hash_computed) return true;

  buf.print("struct ");
  if (std::strcmp(st->space->name, GLOBAL_NAMESPACE)) buf.print_no("%s::", st->space->name);
  buf.print("%s \n", st->name);
  for (auto* elem : st->elements) {
    if (elem->array_suffix) {
      buf.print("[%llu] ", elem->array_suffix->size);
    }
    if (elem->type == TYPE_CUSTOM) {
      auto* enm = symtable->find_enum(elem);
      if (enm != nullptr) {
        buf.print("%s %s;\n", elem->custom_name, elem->name);
        continue;
      }
      auto* inner_st = symtable->find_struct(elem);
      if (!inner_st) {
        interp->Error(elem, "Could not find element %s in the symbol table for hashing\n",
                      elem->name);
        return false;
      }
      assert(inner_st);
      bool bret = ComputeHash(inner_st, symtable, interp);
      if (!bret) return false;
      buf.print("%" PRIX64 " %s;\n", inner_st->hash_value, elem->name);
    } else {
      buf.print("%s %s; \n", ElementTypeToStrC[elem->type], elem->name);
    }
  }

  st->hash_value = hash((const unsigned char*)buf.get_buffer());
  st->hash_computed = true;
  return true;
}

SymbolTable* SchemaParser::symbolTable() const {
  return this->sym;
}

ast_global* SchemaParser::parsedAst() const {
  return this->ast;
}

const std::string& SchemaParser::lastError() const {
  return this->errors;
}

bool SchemaParser::computeHashes(ast_global* ast, SymbolTable* symtable) {
  Interp interp;

  for (auto* st : ast->global_space.structs) {
    if (!ComputeHash(st, symtable, &interp)) {
      WriteError("Could not compute hash for %s. %s", st->name, interp.getErrorString());
      return false;
    }
  }

  for (auto* ns : ast->spaces) {
    for (auto* st : ns->structs) {
      if (!ComputeHash(st, symtable, &interp)) {
        WriteError("Could not compute hash for %s::%s. %s", ns->name, st->name,
                   interp.getErrorString());
        return false;
      }
    }
  }

  return true;
}

std::string SchemaParser::TypeName(const ast_element* elem, const SymbolTable* symtable) {
  switch (elem->type) {
    case TYPE_U8:
      return "uint8";
    case TYPE_U16:
      return "uint16";
    case TYPE_U32:
      return "uint32";
    case TYPE_U64:
      return "uint64";
    case TYPE_S8:
      return "int8";
    case TYPE_S16:
      return "int16";
    case TYPE_S32:
      return "int32";
    case TYPE_S64:
      return "int64";
    case TYPE_F32:
      return "float32";
    case TYPE_F64:
      return "float64";
    case TYPE_STRING:
    case TYPE_SHORT_STRING:
      return "string";
    case TYPE_BOOL:
      return "bool";
    case TYPE_CUSTOM: {
      // Check if this is an enum
      if (symtable->find_enum(elem)) {
        return "int32";
      }

      // Create the full name of the type. `namespace::type` or `type` for globals
      if (elem->namespace_name) {
        return std::string{elem->namespace_name} + "::" + elem->custom_name;
      } else if (elem->enclosing_struct && elem->enclosing_struct->space->name) {
        return std::string{elem->enclosing_struct->space->name} + "::" + elem->custom_name;
      }
      return elem->custom_name;
    }
  }
}

bool SchemaParser::IsComplex(const ast_element* elem, const SymbolTable* symtable) {
  if (elem->type == TYPE_CUSTOM) {
    return !symtable->find_enum(elem);
  }
  return false;
}
