#pragma once

#include "CBufParser.h"
#include "ast.h"

class SchemaParser : public CBufParser {
public:
  ast_global* parsedAst() const;
  const std::string& lastError() const;
  bool computeHashes(ast_global* ast, SymbolTable* symtable);

  static std::string TypeName(const ast_element* elem, const SymbolTable* symtable);
  static bool IsComplex(const ast_element* elem, const SymbolTable* symtable);
};
