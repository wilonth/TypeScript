/// <reference path="checker.ts"/>

/* @internal */
namespace ts {
    const delimiters = createDelimiterMap();
    const brackets = createBracketsMap();

    const CLASS_STRUCT_SUFFIX = "d"
    const CLASS_INTERFACE_SUFFIX = ""

    interface ModuleElementDeclarationEmitInfo {
        node: Node;
        outputPos: number;
        indent: number;
        asynchronousOutput?: string; // If the output for alias was written asynchronously, the corresponding output
        subModuleElementDeclarationEmitInfo?: ModuleElementDeclarationEmitInfo[];
        isVisible?: boolean;
    }

    interface DeclarationEmit {
        reportedDeclarationError: boolean;
        moduleElementDeclarationEmitInfo: ModuleElementDeclarationEmitInfo[];
        synchronousDeclarationOutput: string;
        referencesOutput: string;
    }

    interface EmitTextWriterWithSymbolWriter extends EmitTextWriter, SymbolWriter {}

    export function getDeclarationDiagnostics(host: EmitHost, resolver: EmitResolver, targetSourceFile: SourceFile): Diagnostic[] {
        const declarationDiagnostics = createDiagnosticCollection();
        forEachEmittedFile(host, getDeclarationDiagnosticsFromFile, targetSourceFile);
        return declarationDiagnostics.getDiagnostics(targetSourceFile ? targetSourceFile.fileName : undefined);

        function getDeclarationDiagnosticsFromFile({ declarationFilePath }: EmitFileNames, sourceFileOrBundle: SourceFile | Bundle) {
            emitDeclarations(host, resolver, declarationDiagnostics, declarationFilePath, sourceFileOrBundle, /*emitOnlyDtsFiles*/ false);
        }
    }

    function emitDeclarations(host: EmitHost, resolver: EmitResolver, emitterDiagnostics: DiagnosticCollection, declarationFilePath: string,
        sourceFileOrBundle: SourceFile | Bundle, emitOnlyDtsFiles: boolean): DeclarationEmit {
        const sourceFiles = sourceFileOrBundle.kind === SyntaxKind.Bundle ? sourceFileOrBundle.sourceFiles : [sourceFileOrBundle];
        const isBundledEmit = sourceFileOrBundle.kind === SyntaxKind.Bundle;
        const newLine = host.getNewLine();
        const compilerOptions = host.getCompilerOptions();

        let write: (s: string) => void;
        let writeLine: () => void;
        let increaseIndent: () => void;
        let decreaseIndent: () => void;
        let writeTextOfNode: (text: string, node: Node) => void;

        let writer: EmitTextWriterWithSymbolWriter;

        createAndSetNewTextWriterWithSymbolWriter();

        let enclosingDeclaration: Node;
        let resultHasExternalModuleIndicator: boolean;
        let currentText: string;
        let currentLineMap: number[];
        let currentIdentifiers: Map<string>;
        let isCurrentFileExternalModule: boolean;
        let reportedDeclarationError = false;
        let errorNameNode: DeclarationName;
        const emit = emitNode;

        //let handlers: PrintHandlers = {}
        let currentSourceFile: SourceFile
        let globalStatements: Statement[]

        let moduleElementDeclarationEmitInfo: ModuleElementDeclarationEmitInfo[] = [];
        let asynchronousSubModuleDeclarationEmitInfo: ModuleElementDeclarationEmitInfo[];

        // Contains the reference paths that needs to go in the declaration file.
        // Collecting this separately because reference paths need to be first thing in the declaration file
        // and we could be collecting these paths from multiple files into single one with --out option
        let referencesOutput = "";

        let usedTypeDirectiveReferences: Map<string>;

        // Emit references corresponding to each file
        const emittedReferencedFiles: SourceFile[] = [];
        let addedGlobalFileReference = false;
        let allSourcesModuleElementDeclarationEmitInfo: ModuleElementDeclarationEmitInfo[] = [];
        forEach(sourceFiles, sourceFile => {
            // Check what references need to be added
            if (!compilerOptions.noResolve) {
                forEach(sourceFile.referencedFiles, fileReference => {
                    const referencedFile = tryResolveScriptReference(host, sourceFile, fileReference);

                    // Emit reference in dts, if the file reference was not already emitted
                    if (referencedFile && !contains(emittedReferencedFiles, referencedFile)) {
                        // Add a reference to generated dts file,
                        // global file reference is added only
                        //  - if it is not bundled emit (because otherwise it would be self reference)
                        //  - and it is not already added
                        if (writeReferencePath(referencedFile, !isBundledEmit && !addedGlobalFileReference, emitOnlyDtsFiles)) {
                            addedGlobalFileReference = true;
                        }
                        emittedReferencedFiles.push(referencedFile);
                    }
                });
            }

            resultHasExternalModuleIndicator = false;
            if (!isBundledEmit || !isExternalModule(sourceFile)) {
                emitSourceFile(sourceFile);
            }
            else if (isExternalModule(sourceFile)) {
                write(`declare module "${getResolvedExternalModuleName(host, sourceFile)}" {`);
                writeLine();
                increaseIndent();
                emitSourceFile(sourceFile);
                decreaseIndent();
                write("}");
                writeLine();
            }

            // create asynchronous output for the importDeclarations
            if (moduleElementDeclarationEmitInfo.length) {
                const oldWriter = writer;
                forEach(moduleElementDeclarationEmitInfo, aliasEmitInfo => {
                    if (aliasEmitInfo.isVisible && !aliasEmitInfo.asynchronousOutput) {
                        Debug.assert(aliasEmitInfo.node.kind === SyntaxKind.ImportDeclaration);
                        createAndSetNewTextWriterWithSymbolWriter();
                        Debug.assert(aliasEmitInfo.indent === 0 || (aliasEmitInfo.indent === 1 && isBundledEmit));
                        for (let i = 0; i < aliasEmitInfo.indent; i++) {
                            increaseIndent();
                        }
                        writeImportDeclaration(<ImportDeclaration>aliasEmitInfo.node);
                        aliasEmitInfo.asynchronousOutput = writer.getText();
                        for (let i = 0; i < aliasEmitInfo.indent; i++) {
                            decreaseIndent();
                        }
                    }
                });
                setWriter(oldWriter);

                allSourcesModuleElementDeclarationEmitInfo = allSourcesModuleElementDeclarationEmitInfo.concat(moduleElementDeclarationEmitInfo);
                moduleElementDeclarationEmitInfo = [];
            }
        });

        if (usedTypeDirectiveReferences) {
            forEachKey(usedTypeDirectiveReferences, directive => {
                referencesOutput += `/// <reference types="${directive}" />${newLine}`;
            });
        }

        return {
            reportedDeclarationError,
            moduleElementDeclarationEmitInfo: allSourcesModuleElementDeclarationEmitInfo,
            synchronousDeclarationOutput: writer.getText(),
            referencesOutput,
        };

        function createAndSetNewTextWriterWithSymbolWriter(): void {
            const writer = <EmitTextWriterWithSymbolWriter>createTextWriter(newLine);
            writer.trackSymbol = trackSymbol;
            writer.reportInaccessibleThisError = reportInaccessibleThisError;
            writer.reportIllegalExtends = reportIllegalExtends;
            writer.writeKeyword = writer.write;
            writer.writeOperator = writer.write;
            writer.writePunctuation = writer.write;
            writer.writeSpace = writer.write;
            writer.writeStringLiteral = writer.writeLiteral;
            writer.writeParameter = writer.write;
            writer.writeProperty = writer.write;
            writer.writeSymbol = writer.write;
            setWriter(writer);
        }

        function setWriter(newWriter: EmitTextWriterWithSymbolWriter) {
            writer = newWriter;
            write = newWriter.write;
            writeTextOfNode = newWriter.writeTextOfNode;
            writeLine = newWriter.writeLine;
            increaseIndent = newWriter.increaseIndent;
            decreaseIndent = newWriter.decreaseIndent;
        }

        function writeAsynchronousModuleElements(nodes: Node[]) {
            const oldWriter = writer;
            forEach(nodes, declaration => {
                let nodeToCheck: Node;
                if (declaration.kind === SyntaxKind.VariableDeclaration) {
                    nodeToCheck = declaration.parent.parent;
                }
                else if (declaration.kind === SyntaxKind.NamedImports || declaration.kind === SyntaxKind.ImportSpecifier || declaration.kind === SyntaxKind.ImportClause) {
                    Debug.fail("We should be getting ImportDeclaration instead to write");
                }
                else {
                    nodeToCheck = declaration;
                }

                let moduleElementEmitInfo = forEach(moduleElementDeclarationEmitInfo, declEmitInfo => declEmitInfo.node === nodeToCheck ? declEmitInfo : undefined);
                if (!moduleElementEmitInfo && asynchronousSubModuleDeclarationEmitInfo) {
                    moduleElementEmitInfo = forEach(asynchronousSubModuleDeclarationEmitInfo, declEmitInfo => declEmitInfo.node === nodeToCheck ? declEmitInfo : undefined);
                }

                // If the alias was marked as not visible when we saw its declaration, we would have saved the aliasEmitInfo, but if we haven't yet visited the alias declaration
                // then we don't need to write it at this point. We will write it when we actually see its declaration
                // Eg.
                // export function bar(a: foo.Foo) { }
                // import foo = require("foo");
                // Writing of function bar would mark alias declaration foo as visible but we haven't yet visited that declaration so do nothing,
                // we would write alias foo declaration when we visit it since it would now be marked as visible
                if (moduleElementEmitInfo) {
                    if (moduleElementEmitInfo.node.kind === SyntaxKind.ImportDeclaration) {
                        // we have to create asynchronous output only after we have collected complete information
                        // because it is possible to enable multiple bindings as asynchronously visible
                        moduleElementEmitInfo.isVisible = true;
                    }
                    else {
                        createAndSetNewTextWriterWithSymbolWriter();
                        for (let declarationIndent = moduleElementEmitInfo.indent; declarationIndent; declarationIndent--) {
                            increaseIndent();
                        }

                        if (nodeToCheck.kind === SyntaxKind.ModuleDeclaration) {
                            Debug.assert(asynchronousSubModuleDeclarationEmitInfo === undefined);
                            asynchronousSubModuleDeclarationEmitInfo = [];
                        }
                        emit(nodeToCheck);
                        if (nodeToCheck.kind === SyntaxKind.ModuleDeclaration) {
                            moduleElementEmitInfo.subModuleElementDeclarationEmitInfo = asynchronousSubModuleDeclarationEmitInfo;
                            asynchronousSubModuleDeclarationEmitInfo = undefined;
                        }
                        moduleElementEmitInfo.asynchronousOutput = writer.getText();
                    }
                }
            });
            setWriter(oldWriter);
        }

        function recordTypeReferenceDirectivesIfNecessary(typeReferenceDirectives: string[]): void {
            if (!typeReferenceDirectives) {
                return;
            }

            if (!usedTypeDirectiveReferences) {
                usedTypeDirectiveReferences = createMap<string>();
            }
            for (const directive of typeReferenceDirectives) {
                if (!usedTypeDirectiveReferences.has(directive)) {
                    usedTypeDirectiveReferences.set(directive, directive);
                }
            }
        }

        function trackSymbol(symbol: Symbol, _enclosingDeclaration?: Node, meaning?: SymbolFlags) {
            recordTypeReferenceDirectivesIfNecessary(resolver.getTypeReferenceDirectivesForSymbol(symbol, meaning));
        }

        function reportIllegalExtends() {
            if (errorNameNode) {
                reportedDeclarationError = true;
                emitterDiagnostics.add(createDiagnosticForNode(errorNameNode, Diagnostics.extends_clause_of_exported_class_0_refers_to_a_type_whose_name_cannot_be_referenced,
                    declarationNameToString(errorNameNode)));
            }
        }

        function reportInaccessibleThisError() {
            if (errorNameNode) {
                reportedDeclarationError = true;
                emitterDiagnostics.add(createDiagnosticForNode(errorNameNode, Diagnostics.The_inferred_type_of_0_references_an_inaccessible_this_type_A_type_annotation_is_necessary,
                    declarationNameToString(errorNameNode)));
            }
        }

        function writeTypeOfDeclaration(declaration: AccessorDeclaration | VariableLikeDeclaration, type: TypeNode) {
            // use the checker's type, not the declared type,
            // for non-optional initialized parameters that aren't a parameter property
            const shouldUseResolverType = declaration.kind === SyntaxKind.Parameter &&
                resolver.isRequiredInitializedParameter(declaration as ParameterDeclaration);
            if (shouldUseResolverType) {
                write(" ");
                resolver.writeTypeOfDeclaration(declaration, enclosingDeclaration, TypeFormatFlags.None, writer)
            } else if (type) {
                write(" ");
                emitType(type);
            }
        }

        function writeReturnTypeAtSignature(signature: SignatureDeclaration) {
            write(" ");
            if (signature.type) {
                // Write the type
                emitType(signature.type);
            }
            else {
                errorNameNode = signature.name;
                resolver.writeReturnTypeOfSignatureDeclaration(signature, enclosingDeclaration, TypeFormatFlags.UseTypeOfFunction | TypeFormatFlags.UseTypeAliasValue | TypeFormatFlags.DoNotWriteVoid, writer);
                errorNameNode = undefined;
            }
        }

        function emitLines(nodes: Node[]) {
            for (const node of nodes) {
                if (isStatementButNotDeclaration(node) && isTopLevel(node.parent)) {
                    globalStatements.push(node)
                } else {
                    emit(node);
                }
            }
        }

        function emitSeparatedList(nodes: Node[], separator: string, eachNodeEmitFn: (node: Node) => void, canEmitFn?: (node: Node) => boolean) {
            let currentWriterPos = writer.getTextPos();
            for (const node of nodes) {
                if (!canEmitFn || canEmitFn(node)) {
                    if (currentWriterPos !== writer.getTextPos()) {
                        separator == "" ? writeLine() : write(separator);
                    }
                    currentWriterPos = writer.getTextPos();
                    eachNodeEmitFn(node);
                }
            }
        }

        function emitCommaList(nodes: Node[], eachNodeEmitFn: (node: Node) => void, canEmitFn?: (node: Node) => boolean) {
            emitSeparatedList(nodes, ", ", eachNodeEmitFn, canEmitFn);
        }

        function emitType(type: TypeNode | Identifier | QualifiedName) {
            switch (type.kind) {
                case SyntaxKind.AnyKeyword:
                    return write("interface{}")
                case SyntaxKind.StringKeyword:
                    return write("string")
                case SyntaxKind.NumberKeyword:
                    return write("float64")
                case SyntaxKind.BooleanKeyword:
                    return write("bool")
                case SyntaxKind.ObjectKeyword:
                    return write("interface{}")
                case SyntaxKind.VoidKeyword:
                    return
                case SyntaxKind.SymbolKeyword:
                case SyntaxKind.UndefinedKeyword:
                case SyntaxKind.NullKeyword:
                case SyntaxKind.NeverKeyword:
                case SyntaxKind.ThisType:
                case SyntaxKind.LiteralType:
                    return emitTextOfNode(currentText, type);
                case SyntaxKind.ExpressionWithTypeArguments:
                    return emitExpressionWithTypeArguments(<ExpressionWithTypeArguments>type);
                case SyntaxKind.TypeReference:
                    return emitTypeReference(<TypeReferenceNode>type);
                case SyntaxKind.TypeQuery:
                    return emitTypeQuery(<TypeQueryNode>type);
                case SyntaxKind.ArrayType:
                    return emitArrayType(<ArrayTypeNode>type);
                case SyntaxKind.TupleType:
                    return emitTupleType(<TupleTypeNode>type);
                case SyntaxKind.UnionType:
                    return emitUnionType(<UnionTypeNode>type);
                case SyntaxKind.IntersectionType:
                    return emitIntersectionType(<IntersectionTypeNode>type);
                case SyntaxKind.ParenthesizedType:
                    return emitParenType(<ParenthesizedTypeNode>type);
                case SyntaxKind.TypeOperator:
                    return emitTypeOperator(<TypeOperatorNode>type);
                case SyntaxKind.IndexedAccessType:
                    return emitIndexedAccessType(<IndexedAccessTypeNode>type);
                case SyntaxKind.MappedType:
                    return emitMappedType(<MappedTypeNode>type);
                case SyntaxKind.FunctionType:
                case SyntaxKind.ConstructorType:
                    return emitSignatureDeclarationWithJsDocComments(<FunctionOrConstructorTypeNode>type);
                case SyntaxKind.TypeLiteral:
                    return emitTypeLiteral(<TypeLiteralNode>type);
                case SyntaxKind.Identifier:
                    return emitEntityName(<Identifier>type);
                case SyntaxKind.QualifiedName:
                    return emitEntityName(<QualifiedName>type);
                case SyntaxKind.TypePredicate:
                    return emitTypePredicate(<TypePredicateNode>type);
            }

            function writeEntityName(entityName: EntityName | Expression) {
                if (entityName.kind === SyntaxKind.Identifier) {
                    emitIdentifier(<Identifier>entityName)
                }
                else {
                    const left = entityName.kind === SyntaxKind.QualifiedName ? (<QualifiedName>entityName).left : (<PropertyAccessExpression>entityName).expression;
                    const right = entityName.kind === SyntaxKind.QualifiedName ? (<QualifiedName>entityName).right : (<PropertyAccessExpression>entityName).name;
                    writeEntityName(left);
                    write(".");
                    emitTextOfNode(currentText, right);
                }
            }

            function emitEntityName(entityName: EntityNameOrEntityNameExpression) {
                recordTypeReferenceDirectivesIfNecessary(resolver.getTypeReferenceDirectivesForEntityName(entityName));
                writeEntityName(entityName);
            }

            function emitExpressionWithTypeArguments(node: ExpressionWithTypeArguments) {
                if (isEntityNameExpression(node.expression)) {
                    Debug.assert(node.expression.kind === SyntaxKind.Identifier || node.expression.kind === SyntaxKind.PropertyAccessExpression);
                    emitEntityName(node.expression);
                    if (node.typeArguments) {
                        write("<");
                        emitCommaList(node.typeArguments, emitType);
                        write(">");
                    }
                }
            }

            function emitTypeReference(type: TypeReferenceNode) {
                emitEntityName(type.typeName);
                if (type.typeArguments) {
                    write("<");
                    emitCommaList(type.typeArguments, emitType);
                    write(">");
                }
            }

            function emitTypePredicate(type: TypePredicateNode) {
                emitTextOfNode(currentText, type.parameterName);
                write(" is ");
                emitType(type.type);
            }

            function emitTypeQuery(type: TypeQueryNode) {
                write("typeof ");
                emitEntityName(type.exprName);
            }

            function emitArrayType(type: ArrayTypeNode) {
                emitType(type.elementType);
                write("[]");
            }

            function emitTupleType(type: TupleTypeNode) {
                write("[");
                emitCommaList(type.elementTypes, emitType);
                write("]");
            }

            function emitUnionType(type: UnionTypeNode) {
                emitSeparatedList(type.types, " | ", emitType);
            }

            function emitIntersectionType(type: IntersectionTypeNode) {
                emitSeparatedList(type.types, " & ", emitType);
            }

            function emitParenType(type: ParenthesizedTypeNode) {
                write("(");
                emitType(type.type);
                write(")");
            }

            function emitTypeOperator(type: TypeOperatorNode) {
                write(tokenToString(type.operator));
                write(" ");
                emitType(type.type);
            }

            function emitIndexedAccessType(node: IndexedAccessTypeNode) {
                emitType(node.objectType);
                write("[");
                emitType(node.indexType);
                write("]");
            }

            function emitMappedType(node: MappedTypeNode) {
                const prevEnclosingDeclaration = enclosingDeclaration;
                enclosingDeclaration = node;
                write("{");
                writeLine();
                increaseIndent();
                if (node.readonlyToken) {
                    write("readonly ");
                }
                write("[");
                writeEntityName(node.typeParameter.name);
                write(" in ");
                emitType(node.typeParameter.constraint);
                write("]");
                if (node.questionToken) {
                    write("?");
                }
                write(": ");
                emitType(node.type);
                write(";");
                writeLine();
                decreaseIndent();
                write("}");
                enclosingDeclaration = prevEnclosingDeclaration;
            }

            function emitTypeLiteral(type: TypeLiteralNode) {
                write("{");
                if (type.members.length) {
                    writeLine();
                    increaseIndent();
                    // write members
                    emitLines(type.members);
                    decreaseIndent();
                }
                write("}");
            }
        }

        function emitSourceFile(sourceFile: SourceFile) {
            writePackageLine("main")
            writePrelude()
            globalStatements = []
            currentText = sourceFile.text;
            currentLineMap = getLineStarts(sourceFile);
            currentIdentifiers = sourceFile.identifiers;
            isCurrentFileExternalModule = isExternalModule(sourceFile);
            enclosingDeclaration = sourceFile;
            currentSourceFile = sourceFile;
            emitDetachedComments(currentText, currentLineMap, writer, writeCommentRange, sourceFile, newLine, /*removeComents*/ true);
            emitLines(sourceFile.statements);
            writeLine()
            let main = createIdentifier("main")
            let mainFunc = createFunctionDeclaration([], [], undefined, main, [], [], undefined,
                createBlock(globalStatements, true))
            mainFunc.parent = sourceFile
            emit(mainFunc)
        }

        function writePrelude() {
            write('import . "github.com/wilonth/tsnative-prelude"')
            writeLine()
            writeLine()
        }

        function writePackageLine(package: string) {
            write("package ")
            write(package)
            writeLine()
        }

        // Return a temp variable name to be used in `export default`/`export class ... extends` statements.
        // The temp name will be of the form _default_counter.
        // Note that export default is only allowed at most once in a module, so we
        // do not need to keep track of created temp names.
        function getExportTempVariableName(baseName: string): string {
            if (!currentIdentifiers.has(baseName)) {
                return baseName;
            }
            let count = 0;
            while (true) {
                count++;
                const name = baseName + "_" + count;
                if (!currentIdentifiers.has(name)) {
                    return name;
                }
            }
        }

        function emitTempVariableDeclaration(expr: Expression, baseName: string): string {
            const tempVarName = getExportTempVariableName(baseName);
            write("const ");
            write(tempVarName);
            write(" ");
            resolver.writeTypeOfExpression(expr, enclosingDeclaration, TypeFormatFlags.UseTypeOfFunction | TypeFormatFlags.UseTypeAliasValue, writer);
            write(";");
            writeLine();
            return tempVarName;
        }

        function emitExportAssignment(node: ExportAssignment) {
            if (node.expression.kind === SyntaxKind.Identifier) {
                write(node.isExportEquals ? "export = " : "export default ");
                emitTextOfNode(currentText, node.expression);
            }
            else {
                const tempVarName = emitTempVariableDeclaration(node.expression, "_default");
                write(node.isExportEquals ? "export = " : "export default ");
                write(tempVarName);
            }
            write(";");
            writeLine();

            // Make all the declarations visible for the export name
            if (node.expression.kind === SyntaxKind.Identifier) {
                const nodes = resolver.collectLinkedAliases(<Identifier>node.expression);

                // write each of these declarations asynchronously
                writeAsynchronousModuleElements(nodes);
            }
        }

        function emitModuleElementDeclarationFlags(node: Node) {
            // If the node is parented in the current source file we need to emit export declare or just export
            if (node.parent.kind === SyntaxKind.SourceFile) {
            }
        }

        function emitImportEqualsDeclaration(node: ImportEqualsDeclaration) {
            // note usage of writer. methods instead of aliases created, just to make sure we are using
            // correct writer especially to handle asynchronous alias writing
            if (hasModifier(node, ModifierFlags.Export)) {
                write("export ");
            }
            write("import ");
            emitTextOfNode(currentText, node.name);
            write(" = ");
            if (isInternalModuleImportEqualsDeclaration(node)) {
                emitType(<EntityName>node.moduleReference);
                write(";");
            }
            else {
                write("require(");
                emitExternalModuleSpecifier(node);
                write(");");
            }
            writer.writeLine();
        }

        function isVisibleNamedBinding(namedBindings: NamespaceImport | NamedImports): boolean {
            if (namedBindings) {
                if (namedBindings.kind === SyntaxKind.NamespaceImport) {
                    return resolver.isDeclarationVisible(<NamespaceImport>namedBindings);
                }
                else {
                    return forEach((<NamedImports>namedBindings).elements, namedImport => resolver.isDeclarationVisible(namedImport));
                }
            }
        }

        function writeImportDeclaration(node: ImportDeclaration) {

            if (hasModifier(node, ModifierFlags.Export)) {
                write("export ");
            }
            write("import ");
            if (node.importClause) {
                const currentWriterPos = writer.getTextPos();
                if (node.importClause.name && resolver.isDeclarationVisible(node.importClause)) {
                    emitTextOfNode(currentText, node.importClause.name);
                }
                if (node.importClause.namedBindings && isVisibleNamedBinding(node.importClause.namedBindings)) {
                    if (currentWriterPos !== writer.getTextPos()) {
                        // If the default binding was emitted, write the separated
                        write(", ");
                    }
                    if (node.importClause.namedBindings.kind === SyntaxKind.NamespaceImport) {
                        write("* as ");
                        emitTextOfNode(currentText, (<NamespaceImport>node.importClause.namedBindings).name);
                    }
                    else {
                        write("{ ");
                        emitCommaList((<NamedImports>node.importClause.namedBindings).elements, emitImportOrExportSpecifier, resolver.isDeclarationVisible);
                        write(" }");
                    }
                }
                write(" from ");
            }
            emitExternalModuleSpecifier(node);
            write(";");
            writer.writeLine();
        }

        function emitExternalModuleSpecifier(parent: ImportEqualsDeclaration | ImportDeclaration | ExportDeclaration | ModuleDeclaration) {
            // emitExternalModuleSpecifier is usually called when we emit something in the.d.ts file that will make it an external module (i.e. import/export declarations).
            // the only case when it is not true is when we call it to emit correct name for module augmentation - d.ts files with just module augmentations are not considered
            // external modules since they are indistinguishable from script files with ambient modules. To fix this in such d.ts files we'll emit top level 'export {}'
            // so compiler will treat them as external modules.
            resultHasExternalModuleIndicator = resultHasExternalModuleIndicator || parent.kind !== SyntaxKind.ModuleDeclaration;
            let moduleSpecifier: Node;
            if (parent.kind === SyntaxKind.ImportEqualsDeclaration) {
                const node = parent as ImportEqualsDeclaration;
                moduleSpecifier = getExternalModuleImportEqualsDeclarationExpression(node);
            }
            else if (parent.kind === SyntaxKind.ModuleDeclaration) {
                moduleSpecifier = (<ModuleDeclaration>parent).name;
            }
            else {
                const node = parent as (ImportDeclaration | ExportDeclaration);
                moduleSpecifier = node.moduleSpecifier;
            }

            if (moduleSpecifier.kind === SyntaxKind.StringLiteral && isBundledEmit && (compilerOptions.out || compilerOptions.outFile)) {
                const moduleName = getExternalModuleNameFromDeclaration(host, resolver, parent);
                if (moduleName) {
                    write('"');
                    write(moduleName);
                    write('"');
                    return;
                }
            }

            emitTextOfNode(currentText, moduleSpecifier);
        }

        function emitImportOrExportSpecifier(node: ImportOrExportSpecifier) {
            if (node.propertyName) {
                emitTextOfNode(currentText, node.propertyName);
                write(" as ");
            }
            emitTextOfNode(currentText, node.name);
        }

        function emitModuleDeclaration(node: ModuleDeclaration) {
            emitModuleElementDeclarationFlags(node);
            if (isGlobalScopeAugmentation(node)) {
                write("global ");
            }
            else {
                if (node.flags & NodeFlags.Namespace) {
                    write("namespace ");
                }
                else {
                    write("module ");
                }
                if (isExternalModuleAugmentation(node)) {
                    emitExternalModuleSpecifier(node);
                }
                else {
                    emitTextOfNode(currentText, node.name);
                }
            }
            while (node.body && node.body.kind !== SyntaxKind.ModuleBlock) {
                node = <ModuleDeclaration>node.body;
                write(".");
                emitTextOfNode(currentText, node.name);
            }
            const prevEnclosingDeclaration = enclosingDeclaration;
            if (node.body) {
                enclosingDeclaration = node;
                write(" {");
                writeLine();
                increaseIndent();
                emitLines((<ModuleBlock>node.body).statements);
                decreaseIndent();
                write("}");
                writeLine();
                enclosingDeclaration = prevEnclosingDeclaration;
            }
            else {
                write(";");
            }
        }

        function emitTypeAliasDeclaration(node: TypeAliasDeclaration) {
            const prevEnclosingDeclaration = enclosingDeclaration;
            enclosingDeclaration = node;

            emitModuleElementDeclarationFlags(node);
            write("type ");
            emitTextOfNode(currentText, node.name);
            emitTypeParameters(node.typeParameters);
            write(" = ");
            emitType(node.type);
            write(";");
            writeLine();
            enclosingDeclaration = prevEnclosingDeclaration;
        }

        function emitEnumDeclaration(node: EnumDeclaration) {
            emitModuleElementDeclarationFlags(node);
            if (isConst(node)) {
                write("const ");
            }
            write("enum ");
            emitTextOfNode(currentText, node.name);
            write(" {");
            writeLine();
            increaseIndent();
            emitLines(node.members);
            decreaseIndent();
            write("}");
            writeLine();
        }

        function emitEnumMember(node: EnumMember) {
            emitTextOfNode(currentText, node.name);
            const enumMemberValue = resolver.getConstantValue(node);
            if (enumMemberValue !== undefined) {
                write(" = ");
                write(enumMemberValue.toString());
            }
            write(",");
            writeLine();
        }

        // function isPrivateMethodTypeParameter(node: TypeParameterDeclaration) {
        //     return node.parent.kind === SyntaxKind.MethodDeclaration && hasModifier(node.parent, ModifierFlags.Private);
        // }

        function emitTypeParameters(_typeParameters: TypeParameterDeclaration[]) {
            /*function emitTypeParameter(node: TypeParameterDeclaration) {
                increaseIndent();

                decreaseIndent();
                emitTextOfNode(currentText, node.name);
                // If there is constraint present and this is not a type parameter of the private method emit the constraint
                if (node.constraint && !isPrivateMethodTypeParameter(node)) {
                    write(" extends ");
                    if (node.parent.kind === SyntaxKind.FunctionType ||
                        node.parent.kind === SyntaxKind.ConstructorType ||
                        (node.parent.parent && node.parent.parent.kind === SyntaxKind.TypeLiteral)) {
                        Debug.assert(node.parent.kind === SyntaxKind.MethodDeclaration ||
                            node.parent.kind === SyntaxKind.MethodSignature ||
                            node.parent.kind === SyntaxKind.FunctionType ||
                            node.parent.kind === SyntaxKind.ConstructorType ||
                            node.parent.kind === SyntaxKind.CallSignature ||
                            node.parent.kind === SyntaxKind.ConstructSignature);
                        emitType(node.constraint);
                    }
                    else {
                        emitType(node.constraint);
                    }
                }
                if (node.default && !isPrivateMethodTypeParameter(node)) {
                    write(" = ");
                    if (node.parent.kind === SyntaxKind.FunctionType ||
                        node.parent.kind === SyntaxKind.ConstructorType ||
                        (node.parent.parent && node.parent.parent.kind === SyntaxKind.TypeLiteral)) {
                        Debug.assert(node.parent.kind === SyntaxKind.MethodDeclaration ||
                            node.parent.kind === SyntaxKind.MethodSignature ||
                            node.parent.kind === SyntaxKind.FunctionType ||
                            node.parent.kind === SyntaxKind.ConstructorType ||
                            node.parent.kind === SyntaxKind.CallSignature ||
                            node.parent.kind === SyntaxKind.ConstructSignature);
                        emitType(node.default);
                    }
                    else {
                        emitType(node.default);
                    }
                }
            }

            if (typeParameters) {
                write("<");
                emitCommaList(typeParameters, emitTypeParameter);
                write(">");
            }*/
        }

        function emitHeritageEmbedded(typeReferences: ExpressionWithTypeArguments[], suffix: string) {
            typeReferences.forEach(ref => {
                emitType(ref)
                write(suffix)
                writeLine()
            })
        }

        function getClassMembersStructure(node: ClassDeclaration) {
            let constructor: ConstructorDeclaration | undefined
            let methods: MethodDeclaration[] = []
            let properties: PropertyDeclaration[] = []
            node.members.forEach((mem) => {
                switch (mem.kind) {
                case SyntaxKind.Constructor:
                    constructor = <ConstructorDeclaration>mem
                    break
                case SyntaxKind.MethodDeclaration:
                    methods.push(<MethodDeclaration>mem)
                    break
                case SyntaxKind.PropertyDeclaration:
                    properties.push(<PropertyDeclaration>mem)
                    break
                }
            })

            return {
                constructor,
                methods,
                properties
            }
        }

        function emitClassDeclaration(node: ClassDeclaration) {
            const prevEnclosingDeclaration = enclosingDeclaration;
            enclosingDeclaration = node;

            let mems = getClassMembersStructure(node);
            let className = getEmittedIdentifierName(node.name)
            let structName = className + CLASS_STRUCT_SUFFIX
            let paramProps = getParameterProperties(getFirstConstructorWithBody(node))
            let props = mems.properties.concat(...paramProps);

            // emit data struct
            write("type ");
            write(structName + " struct {");
            writeLine();
            increaseIndent();
            let extendClause = getClassExtendsHeritageClauseElement(node);
            if (extendClause) {
                emitHeritageEmbedded([extendClause], CLASS_INTERFACE_SUFFIX);
            }
            emitLines(props);
            decreaseIndent();
            write("}");
            writeLine();
            //

            // emit interface
            write("type ");
            write(className + CLASS_INTERFACE_SUFFIX + " interface {");
            writeLine();
            increaseIndent();

            let parentMembers: SymbolTable
            let parentRef = extendClause ? extendClause.expression : undefined
            if (extendClause) {
                emitHeritageEmbedded([extendClause], CLASS_INTERFACE_SUFFIX);
                let parent = resolver.resolveEntityName(<EntityNameOrEntityNameExpression>parentRef,
                    SymbolFlags.Class, true, false, extendClause)
                parentMembers = parent.members
            }
            emitClassInterfaceMethods(parentMembers, props, mems.methods)
            writeLine();
            decreaseIndent();
            write("}");
            writeLine();
            //

            // emit method implementations
            emitClassMethodImpls(structName, parentRef, parentMembers, props, mems.methods);
            enclosingDeclaration = prevEnclosingDeclaration;

            // emit constructor
            emitClassConstructor(className, mems.constructor, parentRef, parentMembers)

            function getParameterProperties(constructorDeclaration: ConstructorDeclaration): PropertyDeclaration[] {
                if (constructorDeclaration) {
                    return constructorDeclaration.parameters.filter(param => {
                        return hasModifier(param, ModifierFlags.ParameterPropertyModifier)
                    })
                    .map(item => {
                        return createProperty(item.decorators, item.modifiers,
                            <Identifier>item.name, item.questionToken, item.type, item.initializer)
                    }
                    );
                }
                return []
            }

            function emitClassInterfaceMethods(parentMembers: SymbolTable, props: PropertyDeclaration[], methods: MethodDeclaration[]) {
                props.forEach(prop => {
                    if (isIdentifier(prop.name) && !parentAlreadyHasMember(prop.name)) {
                        let name = getEmittedIdentifierName(prop.name);
                        write(`Get${name}__() `);
                        writeTypeOfDeclaration(prop, prop.type);
                        writeLine();
                        if (!hasModifier(prop, ModifierFlags.Readonly)) {
                            write(`Set${name}__(value `);
                            writeTypeOfDeclaration(prop, prop.type);
                            write(")");
                            writeLine();
                        }
                    }
                })
                methods.forEach(method => {
                    if (isIdentifier(method.name) && !parentAlreadyHasMember(method.name)) {
                        emitIdentifier(method.name);
                        emitSignatureDeclaration(method);
                        writeLine();
                    }
                })

                function parentAlreadyHasMember(name: Identifier) {
                    return parentMembers && parentMembers.has(name.text)
                }
            }

            function emitClassMethodImpls(receiverType: string, parentRef: Expression, parentMembers: SymbolTable, props: PropertyDeclaration[], methods: MethodDeclaration[]) {
                props.forEach(prop => {
                    if (isIdentifier(prop.name)) {
                        let name = getEmittedIdentifierName(prop.name);
                        write(`func (this *${receiverType}) Get${name}__() `)
                        writeTypeOfDeclaration(prop, prop.type)
                        write(`{ return this.${name} }`)
                        writeLine()
                        write(`func (this *${receiverType}) Set${name}__(value `)
                        writeTypeOfDeclaration(prop, prop.type)
                        write(`) { this.${name} = value }`)
                        writeLine()
                    }
                })
                methods.forEach(method => {
                    if (isIdentifier(method.name)) {
                        let parentMethod: Symbol = parentMembers && parentMembers.get(method.name.text)
                        emitFunctionDeclaration(method, {
                            receiverType,
                            parentMethod: parentMethod ? <MethodDeclaration>parentMethod.declarations[0] : method,
                        })
                    }
                })
                if (parentMembers) {
                    let prefName = transformName(getTextOfNode(parentRef));
                    write(`func (this *${receiverType}) super() ${prefName}${CLASS_INTERFACE_SUFFIX} `);
                    write(`{ return this.${prefName}${CLASS_INTERFACE_SUFFIX} }`);
                    writeLine();
                }
            }

            function emitClassConstructor(className: string, constructor: ConstructorDeclaration, parentRef?: Expression, parentMembers?: SymbolTable) {
                write("func " + constructorNameFor(className));
                let parentConstructor: SignatureDeclaration
                if (constructor) {
                    emitSignatureDeclaration(constructor)
                } else if (parentRef) {
                    let pcons = parentMembers.get("__constructor")
                    if (pcons) {
                        parentConstructor = <SignatureDeclaration>pcons.declarations[0]
                        emitSignatureDeclaration(parentConstructor)
                    }
                }
                write(" ");
                write(className + CLASS_INTERFACE_SUFFIX);
                write(" ");
                if (constructor) {
                    emitBlock(constructor.body, {writeBodyStart, writeBodyEnd})
                } else {
                    writeReturnBody()
                }
                writeLine();
                function writeBodyStart() {
                    writeLine();
                    write(`this := &${className}${CLASS_STRUCT_SUFFIX}{}`);
                    writeLine();
                }
                function writeBodyEnd() {
                    writeLine()
                    write("return this")
                    writeLine()
                }
                function writeReturnBody() {
                    let prefName = transformName(getTextOfNode(parentRef))
                    let pconsName = constructorNameFor(prefName)
                    Debug.assert(parentRef && parentMembers != undefined)
                    write("{ ")
                    let paramList = parentConstructor.parameters
                        .filter(param => isIdentifier(param.name))
                        .map(param => getEmittedIdentifierName(<Identifier>param.name))
                        .join(", ")
                    write(`return &${className}${CLASS_STRUCT_SUFFIX}{`)
                    write(`${prefName}${CLASS_INTERFACE_SUFFIX}: ${pconsName}(${paramList})} }`)
                }
            }
        }

        function constructorNameFor(className: string) {
            return className+"new"
        }

        function emitInterfaceDeclaration(node: InterfaceDeclaration) {
            emitModuleElementDeclarationFlags(node);
            write("interface ");
            emitTextOfNode(currentText, node.name);
            const prevEnclosingDeclaration = enclosingDeclaration;
            enclosingDeclaration = node;
            emitTypeParameters(node.typeParameters);
            const interfaceExtendsTypes = filter(getInterfaceBaseTypeNodes(node), base => isEntityNameExpression(base.expression));
            if (interfaceExtendsTypes && interfaceExtendsTypes.length) {
                emitHeritageEmbedded(interfaceExtendsTypes, "");
            }
            write(" {");
            writeLine();
            increaseIndent();
            emitLines(node.members);
            decreaseIndent();
            write("}");
            writeLine();
            enclosingDeclaration = prevEnclosingDeclaration;
        }

        function emitPropertyDeclaration(node: Declaration) {
            if (hasDynamicName(node)) {
                return;
            }

            emitVariableDeclaration(<VariableDeclaration>node);
            writeLine();
        }

        function emitVariableDeclaration(node: VariableDeclaration | PropertyDeclaration | PropertySignature | ParameterDeclaration) {
            if (isBindingPattern(node.name)) {
                emitBindingPattern(<BindingPattern>node.name);
            } else {
                // If this node is a computed name, it can only be a symbol, because we've already skipped
                // it if it's not a well known symbol. In that case, the text of the name will be exactly
                // what we want, namely the name expression enclosed in brackets.
                emitTextOfNode(currentText, node.name);
                // If optional property emit ? but in the case of parameterProperty declaration with "?" indicating optional parameter for the constructor
                // we don't want to emit property declaration with "?"
                if ((node.kind === SyntaxKind.PropertyDeclaration || node.kind === SyntaxKind.PropertySignature ||
                    (node.kind === SyntaxKind.Parameter && !isParameterPropertyDeclaration(<ParameterDeclaration>node))) && hasQuestionToken(node)) {
                    write("?");
                }
                if ((node.kind === SyntaxKind.PropertyDeclaration || node.kind === SyntaxKind.PropertySignature) && node.parent && node.parent.kind === SyntaxKind.TypeLiteral) {
                    emitTypeOfVariableDeclarationFromTypeLiteral(node);
                }
                else if (resolver.isLiteralConstDeclaration(node)) {
                    write(" = ");
                    resolver.writeLiteralConstValue(node, writer);
                    return;
                }
                else {
                    writeTypeOfDeclaration(node, node.type);
                }
                if (node.initializer) {
                    write(" = ");
                    emitExpression(node.initializer);
                }
            }

            function emitBindingPattern(bindingPattern: BindingPattern) {
                // Only select non-omitted expression from the bindingPattern's elements.
                // We have to do this to avoid emitting trailing commas.
                // For example:
                //      original: var [, c,,] = [ 2,3,4]
                //      emitted: declare var c: number; // instead of declare var c:number, ;
                const elements: Node[] = [];
                for (const element of bindingPattern.elements) {
                    if (element.kind !== SyntaxKind.OmittedExpression) {
                        elements.push(element);
                    }
                }
                emitCommaList(elements, emitBindingElement);
            }

            function emitBindingElement(bindingElement: BindingElement) {
                if (bindingElement.name) {
                    if (isBindingPattern(bindingElement.name)) {
                        emitBindingPattern(<BindingPattern>bindingElement.name);
                    }
                    else {
                        emitTextOfNode(currentText, bindingElement.name);
                        writeTypeOfDeclaration(bindingElement, /*type*/ undefined);
                    }
                }
            }
        }

        function emitTypeOfVariableDeclarationFromTypeLiteral(node: VariableLikeDeclaration) {
            // if this is property of type literal,
            // or is parameter of method/call/construct/index signature of type literal
            // emit only if type is specified
            if (node.type) {
                write(" ");
                emitType(node.type);
            }
        }

        function emitVariableStatement(node: VariableStatement) {
            emitVariableDeclarationList(node.declarationList)
        }

        function emitVariableDeclarationList(node: VariableDeclarationList) {
            write(isConst(node) ? "const " : "var ");
            emitList(node, node.declarations, ListFormat.VariableDeclarationList);
        }

        function emitAccessorDeclaration(node: AccessorDeclaration) {
            if (hasDynamicName(node)) {
                return;
            }

            const accessors = getAllAccessorDeclarations((<ClassDeclaration>node.parent).members, node);
            let accessorWithTypeAnnotation: AccessorDeclaration;

            if (node === accessors.firstAccessor) {
                emitTextOfNode(currentText, node.name);
                if (!hasModifier(node, ModifierFlags.Private)) {
                    accessorWithTypeAnnotation = node;
                    let type = getTypeAnnotationFromAccessor(node);
                    if (!type) {
                        // couldn't get type for the first accessor, try the another one
                        const anotherAccessor = node.kind === SyntaxKind.GetAccessor ? accessors.setAccessor : accessors.getAccessor;
                        type = getTypeAnnotationFromAccessor(anotherAccessor);
                        if (type) {
                            accessorWithTypeAnnotation = anotherAccessor;
                        }
                    }
                    writeTypeOfDeclaration(node, type);
                }
                write(";");
                writeLine();
            }

            function getTypeAnnotationFromAccessor(accessor: AccessorDeclaration): TypeNode {
                if (accessor) {
                    return accessor.kind === SyntaxKind.GetAccessor
                        ? accessor.type // Getter - return type
                        : accessor.parameters.length > 0
                            ? accessor.parameters[0].type // Setter parameter type
                            : undefined;
                }
            }
        }

        function emitFunctionDeclaration(node: FunctionLikeDeclaration, options: {
            receiverType?: string,
            parentMethod?: MethodDeclaration,
        } = {}) {
            // If we are emitting Method/Constructor it isn't moduleElement and hence already determined to be emitting
            // so no need to verify if the declaration is visible
            if (!resolver.isImplementationOfOverload(node)) {
                if (node.kind === SyntaxKind.FunctionDeclaration || node.kind === SyntaxKind.MethodDeclaration) {
                    write("func ");
                    if (options.receiverType) {
                        writeMethodReceiver(options.receiverType);
                        write(" ");
                        emit(node.name);
                        options.parentMethod ? emitSignatureDeclaration(options.parentMethod) : emitSignatureDeclaration(node);
                    } else {
                        emit(node.name);
                        emitSignatureDeclaration(node);
                    }
                }
            }
            if (node.body) {
                write(" ")
                emitBlock(node.body)
                writeLine()
            }
        }

        function writeMethodReceiver(receiverType: string) {
            write("(this *" + receiverType + ")");
        }

        function emitBlock(body: Block | Expression, options: {
                writeBodyStart?: ()=>void,
                writeBodyEnd?: ()=>void,
            } = {}) {
            write("{");
            increaseIndent()
            options.writeBodyStart && options.writeBodyStart();
            if (isBlock(body)) {
                emitList(body, body.statements, ListFormat.MultiLineFunctionBodyStatements);
            }
            options.writeBodyEnd && options.writeBodyEnd();
            decreaseIndent();
            write("}");
        }

        function emitList(parentNode: Node, children: NodeArray<Node>, format: ListFormat, start?: number, count?: number) {
            emitNodeList(emit, parentNode, children, format, start, count);
        }

        function shouldWriteLeadingLineTerminator(_parentNode: Node, _children: NodeArray<Node>, format: ListFormat) {
            if (format & ListFormat.MultiLine) {
                return true
            }
            return false
        }

        function shouldWriteClosingLineTerminator(_parentNode: Node, _children: NodeArray<Node>, format: ListFormat) {
            if (format & ListFormat.MultiLine) {
                return true
            }
            return false
        }

        function shouldWriteSeparatingLineTerminator(_parentNode: Node, _child: Node, format: ListFormat) {
            if (format & ListFormat.SingleLine) {
                return false
            }
            return true
        }

        function emitNodeList(emit: (node: Node) => void, parentNode: Node, children: NodeArray<Node>, format: ListFormat, start = 0, count = children ? children.length - start : 0) {
            const isUndefined = children === undefined;
            if (isUndefined && format & ListFormat.OptionalIfUndefined) {
                return;
            }

            const isEmpty = isUndefined || children.length === 0 || start >= children.length || count === 0;
            if (isEmpty && format & ListFormat.OptionalIfEmpty) {
                return;
            }

            if (format & ListFormat.BracketsMask) {
                write(getOpeningBracket(format));
            }

            // if (onBeforeEmitNodeArray) {
            //     onBeforeEmitNodeArray(children);
            // }

            if (isEmpty) {
                // Write a line terminator if the parent node was multi-line
                if (format & ListFormat.MultiLine) {
                    writeLine();
                }
                else if (format & ListFormat.SpaceBetweenBraces) {
                    write(" ");
                }
            }
            else {
                // Write the opening line terminator or leading whitespace.
                const mayEmitInterveningComments = (format & ListFormat.NoInterveningComments) === 0;
                let shouldEmitInterveningComments = mayEmitInterveningComments;
                if (shouldWriteLeadingLineTerminator(parentNode, children, format)) {
                    writeLine();
                    shouldEmitInterveningComments = false;
                }
                else if (format & ListFormat.SpaceBetweenBraces) {
                    write(" ");
                }

                // Increase the indent, if requested.
                if (format & ListFormat.Indented) {
                    increaseIndent();
                }

                // Emit each child.
                let previousSibling: Node;
                let shouldDecreaseIndentAfterEmit: boolean;
                const delimiter = getDelimiter(format);
                for (let i = 0; i < count; i++) {
                    const child = children[start + i];

                    // Write the delimiter if this is not the first node.
                    if (previousSibling) {
                        write(delimiter);

                        // Write either a line terminator or whitespace to separate the elements.
                        if (shouldWriteSeparatingLineTerminator(previousSibling, child, format)) {
                            // If a synthesized node in a single-line list starts on a new
                            // line, we should increase the indent.
                            if ((format & (ListFormat.LinesMask | ListFormat.Indented)) === ListFormat.SingleLine) {
                                increaseIndent();
                                shouldDecreaseIndentAfterEmit = true;
                            }

                            writeLine();
                            shouldEmitInterveningComments = false;
                        }
                        else if (previousSibling && format & ListFormat.SpaceBetweenSiblings) {
                            write(" ");
                        }
                    } else {
                        shouldEmitInterveningComments = mayEmitInterveningComments;
                    }

                    emit(child);

                    if (shouldDecreaseIndentAfterEmit) {
                        decreaseIndent();
                        shouldDecreaseIndentAfterEmit = false;
                    }

                    previousSibling = child;
                }

                // Write a trailing comma, if requested.
                const hasTrailingComma = (format & ListFormat.AllowTrailingComma) && children.hasTrailingComma;
                if (format & ListFormat.CommaDelimited && hasTrailingComma) {
                    write(",");
                }

                // Decrease the indent, if requested.
                if (format & ListFormat.Indented) {
                    decreaseIndent();
                }

                // Write the closing line terminator or closing whitespace.
                if (shouldWriteClosingLineTerminator(parentNode, children, format)) {
                    writeLine();
                }
                else if (format & ListFormat.SpaceBetweenBraces) {
                    write(" ");
                }

                // if (onAfterEmitNodeArray) {
                //     onAfterEmitNodeArray(children);
                // }
            }
            if (format & ListFormat.BracketsMask) {
                write(getClosingBracket(format));
            }
        }

        function emitExpressionList(parentNode: Node, children: NodeArray<Node>, format: ListFormat, start?: number, count?: number) {
            emitNodeList(emitExpression, parentNode, children, format, start, count);
        }

        function emitSignatureDeclarationWithJsDocComments(node: SignatureDeclaration) {

            emitSignatureDeclaration(node);
        }

        function emitSignatureDeclaration(node: SignatureDeclaration) {
            const prevEnclosingDeclaration = enclosingDeclaration;
            enclosingDeclaration = node;
            let closeParenthesizedFunctionType = false;

            if (node.kind === SyntaxKind.IndexSignature) {
                write("[");
            }
            else {
                if (node.kind === SyntaxKind.Constructor && hasModifier(node, ModifierFlags.Private)) {
                    write("();");
                    writeLine();
                    return;
                }
                // Construct signature or constructor type write new Signature
                if (node.kind === SyntaxKind.ConstructSignature || node.kind === SyntaxKind.ConstructorType) {
                    write("new ");
                }
                else if (node.kind === SyntaxKind.FunctionType) {
                    const currentOutput = writer.getText();
                    // Do not generate incorrect type when function type with type parameters is type argument
                    // This could happen if user used space between two '<' making it error free
                    // e.g var x: A< <Tany>(a: Tany)=>Tany>;
                    if (node.typeParameters && currentOutput.charAt(currentOutput.length - 1) === "<") {
                        closeParenthesizedFunctionType = true;
                        write("(");
                    }
                }
                write("(");
            }

            // Parameters
            emitCommaList(node.parameters, emitParameterDeclaration);

            if (node.kind === SyntaxKind.IndexSignature) {
                write("]");
            }
            else {
                write(")");
            }

            // If this is not a constructor and is not private, emit the return type
            const isFunctionTypeOrConstructorType = node.kind === SyntaxKind.FunctionType || node.kind === SyntaxKind.ConstructorType;
            if (isFunctionTypeOrConstructorType || node.parent.kind === SyntaxKind.TypeLiteral) {
                // Emit type literal signature return type only if specified
                if (node.type) {
                    write(isFunctionTypeOrConstructorType ? " => " : " ");
                    emitType(node.type);
                }
            } else if (node.kind !== SyntaxKind.Constructor && !hasModifier(node, ModifierFlags.Private)) {
                writeReturnTypeAtSignature(node);
            }

            enclosingDeclaration = prevEnclosingDeclaration;

            if (closeParenthesizedFunctionType) {
                write(")");
            }
        }

        function emitParameterDeclaration(node: ParameterDeclaration) {
            increaseIndent();

            if (node.dotDotDotToken) {
                write("...");
            }
            if (isBindingPattern(node.name)) {
                emitBindingPattern(<BindingPattern>node.name);
            }
            else {
                emitIdentifier(node.name);
            }
            if (resolver.isOptionalParameter(node)) {
                write("?");
            }
            decreaseIndent();

            if (node.parent.kind === SyntaxKind.FunctionType ||
                node.parent.kind === SyntaxKind.ConstructorType ||
                node.parent.parent.kind === SyntaxKind.TypeLiteral) {
                emitTypeOfVariableDeclarationFromTypeLiteral(node);
            }
            else if (!hasModifier(node.parent, ModifierFlags.Private)) {
                writeTypeOfDeclaration(node, node.type);
            }

            function emitBindingPattern(bindingPattern: BindingPattern) {
                // We have to explicitly emit square bracket and bracket because these tokens are not store inside the node.
                if (bindingPattern.kind === SyntaxKind.ObjectBindingPattern) {
                    write("{");
                    emitCommaList(bindingPattern.elements, emitBindingElement);
                    write("}");
                }
                else if (bindingPattern.kind === SyntaxKind.ArrayBindingPattern) {
                    write("[");
                    const elements = bindingPattern.elements;
                    emitCommaList(elements, emitBindingElement);
                    if (elements && elements.hasTrailingComma) {
                        write(", ");
                    }
                    write("]");
                }
            }

            function emitBindingElement(bindingElement: BindingElement | OmittedExpression) {
                if (bindingElement.kind === SyntaxKind.OmittedExpression) {
                    // If bindingElement is an omittedExpression (i.e. containing elision),
                    // we will emit blank space (although this may differ from users' original code,
                    // it allows emitSeparatedList to write separator appropriately)
                    // Example:
                    //      original: function foo([, x, ,]) {}
                    //      emit    : function foo([ , x,  , ]) {}
                    write(" ");
                }
                else if (bindingElement.kind === SyntaxKind.BindingElement) {
                    if (bindingElement.propertyName) {
                        // bindingElement has propertyName property in the following case:
                        //      { y: [a,b,c] ...} -> bindingPattern will have a property called propertyName for "y"
                        // We have to explicitly emit the propertyName before descending into its binding elements.
                        // Example:
                        //      original: function foo({y: [a,b,c]}) {}
                        //      emit    : declare function foo({y: [a, b, c]}: { y: [any, any, any] }) void;
                        emitTextOfNode(currentText, bindingElement.propertyName);
                        write(": ");
                    }
                    if (bindingElement.name) {
                        if (isBindingPattern(bindingElement.name)) {
                            // If it is a nested binding pattern, we will recursively descend into each element and emit each one separately.
                            // In the case of rest element, we will omit rest element.
                            // Example:
                            //      original: function foo([a, [[b]], c] = [1,[["string"]], 3]) {}
                            //      emit    : declare function foo([a, [[b]], c]: [number, [[string]], number]): void;
                            //      original with rest: function foo([a, ...c]) {}
                            //      emit              : declare function foo([a, ...c]): void;
                            emitBindingPattern(<BindingPattern>bindingElement.name);
                        }
                        else {
                            Debug.assert(bindingElement.name.kind === SyntaxKind.Identifier);
                            // If the node is just an identifier, we will simply emit the text associated with the node's name
                            // Example:
                            //      original: function foo({y = 10, x}) {}
                            //      emit    : declare function foo({y, x}: {number, any}): void;
                            if (bindingElement.dotDotDotToken) {
                                write("...");
                            }
                            emitIdentifier(bindingElement.name);
                        }
                    }
                }
            }
        }

        function emitNode(node: Node) {
            switch (node.kind) {
                // Declarations
                case SyntaxKind.VariableDeclaration:
                    return emitVariableDeclaration(<VariableDeclaration>node);
                case SyntaxKind.VariableDeclarationList:
                    return emitVariableDeclarationList(<VariableDeclarationList>node);
                case SyntaxKind.FunctionDeclaration:
                    return emitFunctionDeclaration(<FunctionDeclaration>node);
                case SyntaxKind.ClassDeclaration:
                    return emitClassDeclaration(<ClassDeclaration>node);
                case SyntaxKind.InterfaceDeclaration:
                    return emitInterfaceDeclaration(<InterfaceDeclaration>node);
                case SyntaxKind.TypeAliasDeclaration:
                    return emitTypeAliasDeclaration(<TypeAliasDeclaration>node);
                case SyntaxKind.EnumDeclaration:
                    return emitEnumDeclaration(<EnumDeclaration>node);
                case SyntaxKind.ModuleDeclaration:
                    return emitModuleDeclaration(<ModuleDeclaration>node);
                // case SyntaxKind.ModuleBlock:
                //     return emitModuleBlock(<ModuleBlock>node);
                // case SyntaxKind.CaseBlock:
                //     return emitCaseBlock(<CaseBlock>node);
                case SyntaxKind.ImportEqualsDeclaration:
                    return emitImportEqualsDeclaration(<ImportEqualsDeclaration>node);
                // case SyntaxKind.ImportDeclaration:
                //     return emitImportDeclaration(<ImportDeclaration>node);
                // case SyntaxKind.ImportClause:
                //     return emitImportClause(<ImportClause>node);
                // case SyntaxKind.NamespaceImport:
                //     return emitNamespaceImport(<NamespaceImport>node);
                // case SyntaxKind.NamedImports:
                //     return emitNamedImports(<NamedImports>node);
                // case SyntaxKind.ImportSpecifier:
                //     return emitImportSpecifier(<ImportSpecifier>node);
                case SyntaxKind.ExportAssignment:
                    return emitExportAssignment(<ExportAssignment>node);
                case SyntaxKind.ExportDeclaration:
                    return
                // case SyntaxKind.NamedExports:
                //     return emitNamedExports(<NamedExports>node);
                // case SyntaxKind.ExportSpecifier:
                //     return emitExportSpecifier(<ExportSpecifier>node);
                case SyntaxKind.MissingDeclaration:
                    return;
                case SyntaxKind.SourceFile:
                    return emitSourceFile(<SourceFile>node);


                // Type members
                // case SyntaxKind.PropertySignature:
                //     return emitPropertySignature(<PropertySignature>node);
                case SyntaxKind.PropertyDeclaration:
                    return emitPropertyDeclaration(<PropertyDeclaration>node);
                case SyntaxKind.GetAccessor:
                case SyntaxKind.SetAccessor:
                    return emitAccessorDeclaration(<AccessorDeclaration>node);
                // case SyntaxKind.CallSignature:
                //     return emitCallSignature(<CallSignatureDeclaration>node);
                // case SyntaxKind.ConstructSignature:
                //     return emitConstructSignature(<ConstructSignatureDeclaration>node);
                // case SyntaxKind.IndexSignature:
                //     return emitIndexSignature(<IndexSignatureDeclaration>node);

                // Statements
                case SyntaxKind.Block:
                    return emitBlock(<Block>node);
                case SyntaxKind.VariableStatement:
                    return emitVariableStatement(<VariableStatement>node);
                // case SyntaxKind.EmptyStatement:
                //     return emitEmptyStatement();
                case SyntaxKind.ExpressionStatement:
                     return emitExpressionStatement(<ExpressionStatement>node);
                case SyntaxKind.IfStatement:
                    return emitIfStatement(<IfStatement>node);
                // case SyntaxKind.DoStatement:
                //     return emitDoStatement(<DoStatement>node);
                // case SyntaxKind.WhileStatement:
                //     return emitWhileStatement(<WhileStatement>node);
                // case SyntaxKind.ForStatement:
                //     return emitForStatement(<ForStatement>node);
                // case SyntaxKind.ForInStatement:
                //     return emitForInStatement(<ForInStatement>node);
                // case SyntaxKind.ForOfStatement:
                //     return emitForOfStatement(<ForOfStatement>node);
                // case SyntaxKind.ContinueStatement:
                //     return emitContinueStatement(<ContinueStatement>node);
                // case SyntaxKind.BreakStatement:
                //     return emitBreakStatement(<BreakStatement>node);
                case SyntaxKind.ReturnStatement:
                    return emitReturnStatement(<ReturnStatement>node);
                // case SyntaxKind.WithStatement:
                //     return emitWithStatement(<WithStatement>node);
                // case SyntaxKind.SwitchStatement:
                //     return emitSwitchStatement(<SwitchStatement>node);
                // case SyntaxKind.LabeledStatement:
                //     return emitLabeledStatement(<LabeledStatement>node);
                // case SyntaxKind.ThrowStatement:
                //     return emitThrowStatement(<ThrowStatement>node);
                // case SyntaxKind.TryStatement:
                //     return emitTryStatement(<TryStatement>node);

                // Enum
                case SyntaxKind.EnumMember:
                    return emitEnumMember(<EnumMember>node);

            }

            if (isExpression(node)) {
                return emitExpression(node);
            }

            Debug.fail("Cannot handle node kind: " + node.kind)
        }

        function writeToken(token: SyntaxKind, pos: number, _contextNode?: Node) {
            return writeTokenText(token, pos);
        }

        function writeTokenText(token: SyntaxKind, pos?: number) {
            const tokenString = tokenToString(token);
            write(tokenString);
            return pos < 0 ? pos : pos + tokenString.length;
        }

        function writeLineOrSpace(node: Node) {
            if (getEmitFlags(node) & EmitFlags.SingleLine) {
                write(" ");
            }
            else {
                writeLine();
            }
        }

        function emitExpressionStatement(node: ExpressionStatement) {
            emitExpression(node.expression);
            write(";");
        }

        function emitEmbeddedStatement(parent: Node, node: Statement) {
            if (isBlock(node) || getEmitFlags(parent) & EmitFlags.SingleLine) {
                write(" ");
                emit(node);
            }
            else {
                writeLine();
                increaseIndent();
                emit(node);
                decreaseIndent();
            }
        }

        function emitIfStatement(node: IfStatement) {
            const openParenPos = writeToken(SyntaxKind.IfKeyword, node.pos, node);
            write(" ");
            writeToken(SyntaxKind.OpenParenToken, openParenPos, node);
            emitExpression(node.expression);
            writeToken(SyntaxKind.CloseParenToken, node.expression.end, node);
            emitEmbeddedStatement(node, node.thenStatement);
            if (node.elseStatement) {
                writeLineOrSpace(node);
                writeToken(SyntaxKind.ElseKeyword, node.thenStatement.end, node);
                if (node.elseStatement.kind === SyntaxKind.IfStatement) {
                    write(" ");
                    emit(node.elseStatement);
                }
                else {
                    emitEmbeddedStatement(node, node.elseStatement);
                }
            }
        }

        function emitReturnStatement(node: ReturnStatement) {
            writeToken(SyntaxKind.ReturnKeyword, node.pos, /*contextNode*/ node);
            emitExpressionWithPrefix(" ", node.expression);
            write(";");
        }

        function emitExpressionWithPrefix(prefix: string, node: Node) {
            emitNodeWithPrefix(prefix, node, emitExpression);
        }

        function emitNodeWithPrefix(prefix: string, node: Node, emit: (node: Node) => void) {
            if (node) {
                write(prefix);
                emit(node);
            }
        }

        function emitExpression(node: Node): void {
            const kind = node.kind;
            switch (kind) {
                // Literals
                case SyntaxKind.NumericLiteral:
                    return emitNumericLiteral(<NumericLiteral>node);

                case SyntaxKind.StringLiteral:
                case SyntaxKind.RegularExpressionLiteral:
                case SyntaxKind.NoSubstitutionTemplateLiteral:
                    return emitLiteral(<LiteralExpression>node);

                // Identifiers
                case SyntaxKind.Identifier:
                    return emitIdentifier(<Identifier>node);

                // Reserved words
                case SyntaxKind.SuperKeyword:
                    return write("this.super()")

                case SyntaxKind.FalseKeyword:
                case SyntaxKind.NullKeyword:
                case SyntaxKind.TrueKeyword:
                case SyntaxKind.ThisKeyword:
                    writeTokenText(kind);
                    return;

                // Expressions
                case SyntaxKind.CallExpression:
                    return emitCallExpression(<CallExpression>node);
                // case SyntaxKind.ArrayLiteralExpression:
                //     return emitArrayLiteralExpression(<ArrayLiteralExpression>node);
                // case SyntaxKind.ObjectLiteralExpression:
                //     return emitObjectLiteralExpression(<ObjectLiteralExpression>node);
                case SyntaxKind.PropertyAccessExpression:
                     return emitPropertyAccessExpression(<PropertyAccessExpression>node);
                // case SyntaxKind.ElementAccessExpression:
                //     return emitElementAccessExpression(<ElementAccessExpression>node);
                case SyntaxKind.NewExpression:
                    return emitNewExpression(<NewExpression>node);
                // case SyntaxKind.TaggedTemplateExpression:
                //     return emitTaggedTemplateExpression(<TaggedTemplateExpression>node);
                // case SyntaxKind.TypeAssertionExpression:
                //     return emitTypeAssertionExpression(<TypeAssertion>node);
                // case SyntaxKind.ParenthesizedExpression:
                //     return emitParenthesizedExpression(<ParenthesizedExpression>node);
                // case SyntaxKind.FunctionExpression:
                //     return emitFunctionExpression(<FunctionExpression>node);
                // case SyntaxKind.ArrowFunction:
                //     return emitArrowFunction(<ArrowFunction>node);
                // case SyntaxKind.DeleteExpression:
                //     return emitDeleteExpression(<DeleteExpression>node);
                // case SyntaxKind.TypeOfExpression:
                //     return emitTypeOfExpression(<TypeOfExpression>node);
                // case SyntaxKind.VoidExpression:
                //     return emitVoidExpression(<VoidExpression>node);
                // case SyntaxKind.AwaitExpression:
                //     return emitAwaitExpression(<AwaitExpression>node);
                // case SyntaxKind.PrefixUnaryExpression:
                //     return emitPrefixUnaryExpression(<PrefixUnaryExpression>node);
                // case SyntaxKind.PostfixUnaryExpression:
                //     return emitPostfixUnaryExpression(<PostfixUnaryExpression>node);
                case SyntaxKind.BinaryExpression:
                    return emitBinaryExpression(<BinaryExpression>node);
                // case SyntaxKind.ConditionalExpression:
                //     return emitConditionalExpression(<ConditionalExpression>node);
                // case SyntaxKind.TemplateExpression:
                //     return emitTemplateExpression(<TemplateExpression>node);
                // case SyntaxKind.YieldExpression:
                //     return emitYieldExpression(<YieldExpression>node);
                // case SyntaxKind.SpreadElement:
                //     return emitSpreadExpression(<SpreadElement>node);
                // case SyntaxKind.ClassExpression:
                //     return emitClassExpression(<ClassExpression>node);
                // case SyntaxKind.OmittedExpression:
                //     return;
                // case SyntaxKind.AsExpression:
                //     return emitAsExpression(<AsExpression>node);
                // case SyntaxKind.NonNullExpression:
                //     return emitNonNullExpression(<NonNullExpression>node);
                // case SyntaxKind.MetaProperty:
                //     return emitMetaProperty(<MetaProperty>node);

                // // JSX
                // case SyntaxKind.JsxElement:
                //     return emitJsxElement(<JsxElement>node);
                // case SyntaxKind.JsxSelfClosingElement:
                //     return emitJsxSelfClosingElement(<JsxSelfClosingElement>node);

                // // Transformation nodes
                // case SyntaxKind.PartiallyEmittedExpression:
                //     return emitPartiallyEmittedExpression(<PartiallyEmittedExpression>node);

            }

            Debug.fail("Cannot handle expression kind: " + kind)
        }

        // SyntaxKind.NumericLiteral
        function emitNumericLiteral(node: NumericLiteral) {
            emitLiteral(node);
        }

        function getTextOfNode(node: Node, includeTrivia?: boolean): string {
            if (isIdentifier(node) && (nodeIsSynthesized(node) || !node.parent)) {
                return unescapeIdentifier(node.text);
            }
            else if (node.kind === SyntaxKind.StringLiteral && (<StringLiteral>node).textSourceNode) {
                return getTextOfNode((<StringLiteral>node).textSourceNode, includeTrivia);
            }
            else if (isLiteralExpression(node) && (nodeIsSynthesized(node) || !node.parent)) {
                return node.text;
            }
            return getSourceTextOfNodeFromSourceFile(currentSourceFile, node, includeTrivia);
        }

        function getLiteralTextOfNode(node: LiteralLikeNode): string {
            if (node.kind === SyntaxKind.StringLiteral && (<StringLiteral>node).textSourceNode) {
                const textSourceNode = (<StringLiteral>node).textSourceNode;
                if (isIdentifier(textSourceNode)) {
                    return "\"" + escapeNonAsciiCharacters(escapeString(getTextOfNode(textSourceNode))) + "\"";
                }
                else {
                    return getLiteralTextOfNode(textSourceNode);
                }
            }

            return getLiteralText(node, currentSourceFile);
        }

        function needsIndentation(parent: Node, node1: Node, node2: Node): boolean {
            parent = skipSynthesizedParentheses(parent);
            node1 = skipSynthesizedParentheses(node1);
            node2 = skipSynthesizedParentheses(node2);

            // Always use a newline for synthesized code if the synthesizer desires it.
            if (node2.startsOnNewLine) {
                return true;
            }

            return !nodeIsSynthesized(parent)
                && !nodeIsSynthesized(node1)
                && !nodeIsSynthesized(node2)
                && !rangeEndIsOnSameLineAsRangeStart(node1, node2, currentSourceFile);
        }

        function increaseIndentIf(value: boolean, valueToWriteWhenNotIndenting?: string) {
            if (value) {
                increaseIndent();
                writeLine();
            }
            else if (valueToWriteWhenNotIndenting) {
                write(valueToWriteWhenNotIndenting);
            }
        }

        // Helper function to decrease the indent if we previously indented.  Allows multiple
        // previous indent values to be considered at a time.  This also allows caller to just
        // call this once, passing in all their appropriate indent values, instead of needing
        // to call this helper function multiple times.
        function decreaseIndentIf(value1: boolean, value2?: boolean) {
            if (value1) {
                decreaseIndent();
            }
            if (value2) {
                decreaseIndent();
            }
        }

        function skipSynthesizedParentheses(node: Node) {
            while (node.kind === SyntaxKind.ParenthesizedExpression && nodeIsSynthesized(node)) {
                node = (<ParenthesizedExpression>node).expression;
            }

            return node;
        }

        // Expressions
        /*function emitElementAccessExpression(node: ElementAccessExpression) {
            emitExpression(node.expression);
            write("[");
            emitExpression(node.argumentExpression);
            write("]");
        }*/

        function emitPropertyAccessExpression(node: PropertyAccessExpression) {
            let indentBeforeDot = false;
            let indentAfterDot = false;
            if (!(getEmitFlags(node) & EmitFlags.NoIndentation)) {
                const dotRangeStart = node.expression.end;
                const dotRangeEnd = skipTrivia(currentSourceFile.text, node.expression.end) + 1;
                const dotToken = <Node>{ kind: SyntaxKind.DotToken, pos: dotRangeStart, end: dotRangeEnd };
                indentBeforeDot = needsIndentation(node, node.expression, dotToken);
                indentAfterDot = needsIndentation(node, dotToken, node.name);
            }

            emitExpression(node.expression);
            increaseIndentIf(indentBeforeDot);
            write(".");

            increaseIndentIf(indentAfterDot);
            emit(node.name);
            decreaseIndentIf(indentBeforeDot, indentAfterDot);
        }

        function emitBinaryExpression(node: BinaryExpression) {
            const isCommaOperator = node.operatorToken.kind !== SyntaxKind.CommaToken;
            const indentBeforeOperator = needsIndentation(node, node.left, node.operatorToken);
            const indentAfterOperator = needsIndentation(node, node.operatorToken, node.right);

            let resultType = resolver.getRegularTypeOfExpression(node);
            emitExpressionWithNecessaryConversion(node.left, resultType);
            increaseIndentIf(indentBeforeOperator, isCommaOperator ? " " : undefined);
            writeTokenText(node.operatorToken.kind);
            increaseIndentIf(indentAfterOperator, " ");
            emitExpressionWithNecessaryConversion(node.right, resultType);
            decreaseIndentIf(indentBeforeOperator, indentAfterOperator);
        }

        function emitExpressionWithNecessaryConversion(node: Expression, resultType: Type) {
            let type = resolver.getRegularTypeOfExpression(node)
            if (!(type.flags & TypeFlags.StringLike) && resultType.flags & TypeFlags.StringLike) {
                write("Tsn__.ToString(");
                emitExpression(node)
                write(")");
            } else {
                emitExpression(node);
            }
        }

        function emitCallExpression(node: CallExpression) {
            emitExpression(node.expression);
            emitTypeArguments(node, node.typeArguments);
            emitExpressionList(node, node.arguments, ListFormat.CallExpressionArguments);
        }

        function emitNewExpression(node: NewExpression) {
            if (isEntityNameExpression(node.expression)) {
                let symbol = resolver.resolveEntityName(node.expression, SymbolFlags.Class)
                if (symbol) {
                    emitExpression(node.expression);
                    write("new");
                    emitExpressionList(node, node.arguments, ListFormat.NewExpressionArguments);
                    return
                }
            }
            emitExpression(node.expression);
            emitExpressionList(node, node.arguments, ListFormat.NewExpressionArguments);
        }

        // SyntaxKind.StringLiteral
        // SyntaxKind.RegularExpressionLiteral
        // SyntaxKind.NoSubstitutionTemplateLiteral
        // SyntaxKind.TemplateHead
        // SyntaxKind.TemplateMiddle
        // SyntaxKind.TemplateTail
        function emitLiteral(node: LiteralLikeNode) {
            const text = getLiteralTextOfNode(node);
            write(text);
        }

        //
        // Identifiers
        //

        function emitTextOfNode(text: string, node: Node) {
            if (isIdentifier(node)) {
                emitIdentifier(node)
            } else {
                writeTextOfNode(text, node)
            }
        }

        function getEmittedIdentifierName(node: Identifier) {
            let name = getTextOfNode(node, /*includeTrivia*/ false)
            return isSpecialName(name) ? name : transformName(name)
            function isSpecialName(name: string) {
                return name == "main" || name == "this"
            }
        }

        function emitIdentifier(node: Identifier) {
            write(getEmittedIdentifierName(node))
        }

        function transformName(name: string) {
            if (name[0] == name[0].toUpperCase()) {
                return name + "_"
            }
            return name[0].toUpperCase() + name.substr(1)
        }

        function emitTypeArguments(parentNode: Node, typeArguments: NodeArray<TypeNode>) {
            emitList(parentNode, typeArguments, ListFormat.TypeArguments);
        }

        /**
         * Adds the reference to referenced file, returns true if global file reference was emitted
         * @param referencedFile
         * @param addBundledFileReference Determines if global file reference corresponding to bundled file should be emitted or not
         */
        function writeReferencePath(referencedFile: SourceFile, addBundledFileReference: boolean, emitOnlyDtsFiles: boolean): boolean {
            let declFileName: string;
            let addedBundledEmitReference = false;
            if (isDeclarationFile(referencedFile)) {
                // Declaration file, use declaration file name
                declFileName = referencedFile.fileName;
            }
            else {
                // Get the declaration file path
                forEachEmittedFile(host, getDeclFileName, referencedFile, emitOnlyDtsFiles);
            }

            if (declFileName) {
                declFileName = getRelativePathToDirectoryOrUrl(
                    getDirectoryPath(normalizeSlashes(declarationFilePath)),
                    declFileName,
                    host.getCurrentDirectory(),
                    host.getCanonicalFileName,
                    /*isAbsolutePathAnUrl*/ false);

                referencesOutput += `/// <reference path="${declFileName}" />${newLine}`;
            }
            return addedBundledEmitReference;

            function getDeclFileName(emitFileNames: EmitFileNames, sourceFileOrBundle: SourceFile | Bundle) {
                // Dont add reference path to this file if it is a bundled emit and caller asked not emit bundled file path
                const isBundledEmit = sourceFileOrBundle.kind === SyntaxKind.Bundle;
                if (isBundledEmit && !addBundledFileReference) {
                    return;
                }

                Debug.assert(!!emitFileNames.declarationFilePath || isSourceFileJavaScript(referencedFile), "Declaration file is not present only for javascript files");
                declFileName = emitFileNames.declarationFilePath || emitFileNames.jsFilePath;
                addedBundledEmitReference = isBundledEmit;
            }
        }
    }

    /* @internal */
    export function writeDeclarationFile(declarationFilePath: string, sourceFileOrBundle: SourceFile | Bundle, host: EmitHost, resolver: EmitResolver, emitterDiagnostics: DiagnosticCollection, emitOnlyDtsFiles: boolean) {
        const emitDeclarationResult = emitDeclarations(host, resolver, emitterDiagnostics, declarationFilePath, sourceFileOrBundle, emitOnlyDtsFiles);
        const emitSkipped = emitDeclarationResult.reportedDeclarationError || host.isEmitBlocked(declarationFilePath) || host.getCompilerOptions().noEmit;
        if (!emitSkipped) {
            const sourceFiles = sourceFileOrBundle.kind === SyntaxKind.Bundle ? sourceFileOrBundle.sourceFiles : [sourceFileOrBundle];
            const declarationOutput = emitDeclarationResult.referencesOutput
                + getDeclarationOutput(emitDeclarationResult.synchronousDeclarationOutput, emitDeclarationResult.moduleElementDeclarationEmitInfo);
            writeFile(host, emitterDiagnostics, declarationFilePath, declarationOutput, host.getCompilerOptions().emitBOM, sourceFiles);
        }
        return emitSkipped;

        function getDeclarationOutput(synchronousDeclarationOutput: string, moduleElementDeclarationEmitInfo: ModuleElementDeclarationEmitInfo[]) {
            let appliedSyncOutputPos = 0;
            let declarationOutput = "";
            // apply asynchronous additions to the synchronous output
            forEach(moduleElementDeclarationEmitInfo, aliasEmitInfo => {
                if (aliasEmitInfo.asynchronousOutput) {
                    declarationOutput += synchronousDeclarationOutput.substring(appliedSyncOutputPos, aliasEmitInfo.outputPos);
                    declarationOutput += getDeclarationOutput(aliasEmitInfo.asynchronousOutput, aliasEmitInfo.subModuleElementDeclarationEmitInfo);
                    appliedSyncOutputPos = aliasEmitInfo.outputPos;
                }
            });
            declarationOutput += synchronousDeclarationOutput.substring(appliedSyncOutputPos);
            return declarationOutput;
        }
    }

    function createDelimiterMap() {
        const delimiters: string[] = [];
        delimiters[ListFormat.None] = "";
        delimiters[ListFormat.CommaDelimited] = ",";
        delimiters[ListFormat.BarDelimited] = " |";
        delimiters[ListFormat.AmpersandDelimited] = " &";
        return delimiters;
    }

    function getDelimiter(format: ListFormat) {
        return delimiters[format & ListFormat.DelimitersMask];
    }

    function createBracketsMap() {
        const brackets: string[][] = [];
        brackets[ListFormat.Braces] = ["{", "}"];
        brackets[ListFormat.Parenthesis] = ["(", ")"];
        brackets[ListFormat.AngleBrackets] = ["<", ">"];
        brackets[ListFormat.SquareBrackets] = ["[", "]"];
        return brackets;
    }

    function getOpeningBracket(format: ListFormat) {
        return brackets[format & ListFormat.BracketsMask][0];
    }

    function getClosingBracket(format: ListFormat) {
        return brackets[format & ListFormat.BracketsMask][1];
    }

    const enum ListFormat {
        None = 0,

        // Line separators
        SingleLine = 0,                 // Prints the list on a single line (default).
        MultiLine = 1 << 0,             // Prints the list on multiple lines.
        PreserveLines = 1 << 1,         // Prints the list using line preservation if possible.
        LinesMask = SingleLine | MultiLine | PreserveLines,

        // Delimiters
        NotDelimited = 0,               // There is no delimiter between list items (default).
        BarDelimited = 1 << 2,          // Each list item is space-and-bar (" |") delimited.
        AmpersandDelimited = 1 << 3,    // Each list item is space-and-ampersand (" &") delimited.
        CommaDelimited = 1 << 4,        // Each list item is comma (",") delimited.
        DelimitersMask = BarDelimited | AmpersandDelimited | CommaDelimited,

        AllowTrailingComma = 1 << 5,    // Write a trailing comma (",") if present.

        // Whitespace
        Indented = 1 << 6,              // The list should be indented.
        SpaceBetweenBraces = 1 << 7,    // Inserts a space after the opening brace and before the closing brace.
        SpaceBetweenSiblings = 1 << 8,  // Inserts a space between each sibling node.

        // Brackets/Braces
        Braces = 1 << 9,                // The list is surrounded by "{" and "}".
        Parenthesis = 1 << 10,          // The list is surrounded by "(" and ")".
        AngleBrackets = 1 << 11,        // The list is surrounded by "<" and ">".
        SquareBrackets = 1 << 12,       // The list is surrounded by "[" and "]".
        BracketsMask = Braces | Parenthesis | AngleBrackets | SquareBrackets,

        OptionalIfUndefined = 1 << 13,  // Do not emit brackets if the list is undefined.
        OptionalIfEmpty = 1 << 14,      // Do not emit brackets if the list is empty.
        Optional = OptionalIfUndefined | OptionalIfEmpty,

        // Other
        PreferNewLine = 1 << 15,        // Prefer adding a LineTerminator between synthesized nodes.
        NoTrailingNewLine = 1 << 16,    // Do not emit a trailing NewLine for a MultiLine list.
        NoInterveningComments = 1 << 17, // Do not emit comments between each node

        // Precomputed Formats
        Modifiers = SingleLine | SpaceBetweenSiblings,
        HeritageClauses = SingleLine | SpaceBetweenSiblings,
        TypeLiteralMembers = MultiLine | Indented,
        TupleTypeElements = CommaDelimited | SpaceBetweenSiblings | SingleLine | Indented,
        UnionTypeConstituents = BarDelimited | SpaceBetweenSiblings | SingleLine,
        IntersectionTypeConstituents = AmpersandDelimited | SpaceBetweenSiblings | SingleLine,
        ObjectBindingPatternElements = SingleLine | AllowTrailingComma | SpaceBetweenBraces | CommaDelimited | SpaceBetweenSiblings,
        ArrayBindingPatternElements = SingleLine | AllowTrailingComma | CommaDelimited | SpaceBetweenSiblings,
        ObjectLiteralExpressionProperties = PreserveLines | CommaDelimited | SpaceBetweenSiblings | SpaceBetweenBraces | Indented | Braces,
        ArrayLiteralExpressionElements = PreserveLines | CommaDelimited | SpaceBetweenSiblings | AllowTrailingComma | Indented | SquareBrackets,
        CallExpressionArguments = CommaDelimited | SpaceBetweenSiblings | SingleLine | Parenthesis,
        NewExpressionArguments = CommaDelimited | SpaceBetweenSiblings | SingleLine | Parenthesis | OptionalIfUndefined,
        TemplateExpressionSpans = SingleLine | NoInterveningComments,
        SingleLineBlockStatements = SpaceBetweenBraces | SpaceBetweenSiblings | SingleLine,
        MultiLineBlockStatements = Indented | MultiLine,
        VariableDeclarationList = CommaDelimited | SpaceBetweenSiblings | SingleLine,
        SingleLineFunctionBodyStatements = SingleLine | SpaceBetweenSiblings | SpaceBetweenBraces,
        MultiLineFunctionBodyStatements = MultiLine,
        ClassHeritageClauses = SingleLine | SpaceBetweenSiblings,
        ClassMembers = Indented | MultiLine,
        InterfaceMembers = Indented | MultiLine,
        EnumMembers = CommaDelimited | Indented | MultiLine,
        CaseBlockClauses = Indented | MultiLine,
        NamedImportsOrExportsElements = CommaDelimited | SpaceBetweenSiblings | AllowTrailingComma | SingleLine | SpaceBetweenBraces,
        JsxElementChildren = SingleLine | NoInterveningComments,
        JsxElementAttributes = SingleLine | SpaceBetweenSiblings | NoInterveningComments,
        CaseOrDefaultClauseStatements = Indented | MultiLine | NoTrailingNewLine | OptionalIfEmpty,
        HeritageClauseTypes = CommaDelimited | SpaceBetweenSiblings | SingleLine,
        SourceFileStatements = MultiLine | NoTrailingNewLine,
        Decorators = MultiLine | Optional,
        TypeArguments = CommaDelimited | SpaceBetweenSiblings | SingleLine | Indented | AngleBrackets | Optional,
        TypeParameters = CommaDelimited | SpaceBetweenSiblings | SingleLine | Indented | AngleBrackets | Optional,
        Parameters = CommaDelimited | SpaceBetweenSiblings | SingleLine | Indented | Parenthesis,
        IndexSignatureParameters = CommaDelimited | SpaceBetweenSiblings | SingleLine | Indented | SquareBrackets,
    }
}
