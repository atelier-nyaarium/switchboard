// The invented inputs the facet corpus runs over. Only the shapes are load-bearing; the data is free.
//
// Every rule a vector exists for is named in its `name`. A symbol id embeds its module, which is what
// both runtimes gate on, so an id naming `.env` is withheld however served its summary claims to be.
//
// Rows are unordered; both runtimes sort before they page. A use from a subject is written inside it,
// in its module, and the generator refuses a case that says otherwise.

import type { FacetCase, FacetDeclared, FacetModule } from "../../src/testing/facetVectors.js";

////////////////////////////////
//  Constants

const TS = "typescript";

const PORT_MODULE = "src/port.ts";

const USE_MODULE = "src/use.ts";

const SEAL_MODULE = "src/seal.ts";

const DOC_MODULE = "src/doc.ts";

const ENV_MODULE = ".env";

/** A secret by its name alone, though its text is TypeScript the index reads. */
const ENV_LEAF_MODULE = "src/config/.env.ts";

/** Bulk rather than secrets: served when named, hidden only from a listing. */
const VENDOR_MODULE = "node_modules/local-agent/index.ts";

const PORT = "lexicon typescript src/port.ts Port#";

const PORT_OPEN = "lexicon typescript src/port.ts Port#open().";

const PORT_CLOSE = "lexicon typescript src/port.ts Port#close().";

const HANDLER = "lexicon typescript src/use.ts Handler#";

const HANDLER_START = "lexicon typescript src/use.ts Handler#start().";

/** Never declared, so it stands for a local no outline holds. */
const HELD = "lexicon typescript src/use.ts Handler#start().held";

const SECRET = "lexicon typescript .env Secret#";

/** Its id names `.env`; its summary claims a served module. */
const CLOAKED = "lexicon typescript .env Cloaked#";

/** Another declaration spelled `Port`, in another module. */
const OTHER_PORT = "lexicon typescript src/seal.ts Port#";

const VENDORED = "lexicon typescript node_modules/local-agent/index.ts Vendored#";

const ENV_BACKED = "lexicon typescript src/config/.env.ts EnvBacked#";

const DOC = "lexicon typescript src/doc.ts Doc#";

const DOC_READ = "lexicon typescript src/doc.ts Doc#read().";

const SEALING = "lexicon typescript src/seal.ts Sealing#";

const CONTENT = "lexicon typescript src/seal.ts ContentSealing#";

const VAULT = "lexicon typescript src/seal.ts VaultSealing#";

////////////////////////////////
//  Files

const portFile: FacetModule = {
	path: PORT_MODULE,
	language: TS,
	lines: [
		"/** What a port opens onto. */",
		"export interface Port {",
		"\t/** Opens it. */",
		"\topen(handler: Handler): void;",
		"\tclose(): void;",
		"}",
	],
};

const useFile: FacetModule = {
	path: USE_MODULE,
	language: TS,
	lines: [
		'import type { Port } from "./port.js";',
		"",
		"export class Handler implements Port {",
		"\tstart(port: Port, spare: Port) {}",
		"}",
		"",
		"const top: Port = null as unknown as Port;",
	],
};

const sealFile: FacetModule = {
	path: SEAL_MODULE,
	language: TS,
	lines: [
		"export interface Sealing {",
		"\tseal(text: string): string;",
		"}",
		"export class ContentSealing implements Sealing {",
		"\tseal(text: string): string {",
		"\t\treturn text;",
		"\t}",
		"}",
		"export class VaultSealing extends ContentSealing implements Error {",
		'\tname = "VaultSealing";',
		"}",
	],
};

/** Two leading comments over one declaration. */
const docFile: FacetModule = {
	path: DOC_MODULE,
	language: TS,
	lines: [
		"/** What a doc holds. */",
		"/** Written once, read many. */",
		"export interface Doc {",
		"\t/** Reads it. */",
		"\tread(): string;",
		"}",
	],
};

const envFile: FacetModule = { path: ENV_MODULE, language: TS, lines: ["PORT=1"] };

const vendorFile: FacetModule = {
	path: VENDOR_MODULE,
	language: TS,
	lines: ["export class Vendored implements Port {", "\topen() {}", "}"],
};

const envLeafFile: FacetModule = {
	path: ENV_LEAF_MODULE,
	language: TS,
	lines: ["export class EnvBacked implements Port {", "\topen() {}", "}"],
};

////////////////////////////////
//  Declarations

const portSymbols: FacetDeclared[] = [
	{ id: PORT, name: "Port", kind: "interface", module: PORT_MODULE, startLine: 2, endLine: 6 },
	{
		id: PORT_OPEN,
		name: "open",
		kind: "method",
		module: PORT_MODULE,
		startLine: 4,
		endLine: 4,
		container: PORT,
		signature: "open(handler: Handler): void",
	},
	{
		id: PORT_CLOSE,
		name: "close",
		kind: "method",
		module: PORT_MODULE,
		startLine: 5,
		endLine: 5,
		container: PORT,
		signature: "close(): void",
	},
];

const useSymbols: FacetDeclared[] = [
	{ id: HANDLER, name: "Handler", kind: "class", module: USE_MODULE, startLine: 3, endLine: 5 },
	{
		id: HANDLER_START,
		name: "start",
		kind: "method",
		module: USE_MODULE,
		startLine: 4,
		endLine: 4,
		container: HANDLER,
		signature: "start(port: Port, spare: Port): void",
	},
];

const docSymbols: FacetDeclared[] = [
	{ id: DOC, name: "Doc", kind: "interface", module: DOC_MODULE, startLine: 3, endLine: 6 },
	{
		id: DOC_READ,
		name: "read",
		kind: "method",
		module: DOC_MODULE,
		startLine: 5,
		endLine: 5,
		container: DOC,
		signature: "read(): string",
	},
];

const secret: FacetDeclared = {
	id: SECRET,
	name: "Secret",
	kind: "class",
	module: ENV_MODULE,
	startLine: 1,
	endLine: 1,
};

/** Declared in a served module, while its id names a withheld one. */
const cloaked: FacetDeclared = {
	id: CLOAKED,
	name: "Cloaked",
	kind: "class",
	module: USE_MODULE,
	startLine: 3,
	endLine: 5,
};

const vendored: FacetDeclared = {
	id: VENDORED,
	name: "Vendored",
	kind: "class",
	module: VENDOR_MODULE,
	startLine: 1,
	endLine: 3,
};

const envBacked: FacetDeclared = {
	id: ENV_BACKED,
	name: "EnvBacked",
	kind: "class",
	module: ENV_LEAF_MODULE,
	startLine: 1,
	endLine: 3,
};

const otherPort: FacetDeclared = {
	id: OTHER_PORT,
	name: "Port",
	kind: "interface",
	module: SEAL_MODULE,
	startLine: 1,
	endLine: 3,
};

const sealSymbols: FacetDeclared[] = [
	{ id: SEALING, name: "Sealing", kind: "interface", module: SEAL_MODULE, startLine: 1, endLine: 3 },
	{ id: CONTENT, name: "ContentSealing", kind: "class", module: SEAL_MODULE, startLine: 4, endLine: 8 },
	{ id: VAULT, name: "VaultSealing", kind: "class", module: SEAL_MODULE, startLine: 9, endLine: 11 },
];

////////////////////////////////
//  Cases

const withheldRows: FacetCase = {
	name: "a withheld module's rows are dropped before any row is built, and counted nowhere",
	modules: [portFile, useFile, envFile],
	symbols: [...portSymbols, ...useSymbols, secret, cloaked],
	subject: PORT,
	uses: [
		{
			module: USE_MODULE,
			line: 4,
			column: 13,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
		},
		{
			module: USE_MODULE,
			line: 3,
			column: 32,
			name: "Port",
			role: "implements",
			holder: HANDLER,
			topLevel: HANDLER,
		},
		{ module: ENV_MODULE, line: 1, column: 0, name: "Port", role: "typeUse", holder: SECRET, topLevel: SECRET },
		{ module: USE_MODULE, line: 7, column: 11, name: "Port", role: "typeUse", holder: CLOAKED, topLevel: CLOAKED },
	],
	targets: [
		{
			module: PORT_MODULE,
			line: 4,
			column: 15,
			name: "Handler",
			role: "typeUse",
			holder: PORT_OPEN,
			topLevel: PORT,
			status: "bound",
			target: HANDLER,
		},
	],
	members: [PORT_OPEN, CLOAKED, PORT_CLOSE],
	hierarchy: {
		subtypes: [
			{ name: "Port", symbol: HANDLER, role: "implements" },
			{ name: "Port", symbol: SECRET, role: "implements" },
		],
	},
};

const supertypeCount: FacetCase = {
	name: "the supertype count spans direct supertypes, ancestors and unbound names, a repeated direct one twice",
	modules: [sealFile, envFile],
	symbols: [...sealSymbols, secret],
	subject: VAULT,
	targets: [
		{
			module: SEAL_MODULE,
			line: 9,
			column: 34,
			name: "ContentSealing",
			role: "extends",
			holder: VAULT,
			topLevel: VAULT,
			status: "bound",
			target: CONTENT,
		},
		{
			module: SEAL_MODULE,
			line: 9,
			column: 60,
			name: "Error",
			role: "implements",
			holder: VAULT,
			topLevel: VAULT,
			status: "unbound",
			reason: "ExternalDependency",
		},
	],
	hierarchy: {
		// A direct supertype stands twice; an unbound name is named once however often it appears.
		supertypes: [
			{ name: "ContentSealing", symbol: CONTENT, role: "extends" },
			{ name: "ContentSealing", symbol: CONTENT, role: "extends" },
			{ name: "Error", role: "implements" },
			{ name: "Error", role: "implements" },
		],
		// The direct supertype is listed again, and one ancestor is withheld.
		ancestors: [SEALING, CONTENT, SECRET],
	},
};

const ownComment: FacetCase = {
	name: "every own leading comment is documentation, in no row and in no count, not only the first",
	modules: [docFile],
	symbols: docSymbols,
	subject: DOC,
	comments: [
		{ module: DOC_MODULE, line: 1, text: "What a doc holds.", form: "leading", anchor: DOC },
		{ module: DOC_MODULE, line: 2, text: "Written once, read many.", form: "leading", anchor: DOC },
		{ module: DOC_MODULE, line: 4, text: "Reads it.", form: "leading", anchor: DOC_READ },
		{ module: DOC_MODULE, line: 5, text: "Held briefly.", form: "inline", anchor: DOC_READ },
	],
	commentTotal: 4,
};

const commentPage: FacetCase = {
	name: "the comment page caps, and the total drops only the own comments the page held",
	modules: [portFile],
	symbols: portSymbols,
	subject: PORT,
	// Past the page, so the last own comment is documentation the total never drops.
	comments: [
		{ module: PORT_MODULE, line: 1, text: "What a port opens onto.", form: "leading", anchor: PORT },
		...Array.from({ length: 200 }, (_, index) => ({
			module: PORT_MODULE,
			line: 4,
			text: `n${index}`,
			form: "inline",
			anchor: PORT_OPEN,
		})),
		{ module: PORT_MODULE, line: 2, text: "Opened once.", form: "leading", anchor: PORT },
	],
	commentTotal: 202,
};

const holderFallback: FacetCase = {
	name: "a holder and a top level are each read on their own, whether absent or present and withheld",
	modules: [useFile, portFile],
	symbols: [...useSymbols, ...portSymbols, cloaked],
	subject: PORT,
	uses: [
		{
			module: USE_MODULE,
			line: 4,
			column: 13,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
		},
		// A local no outline declares.
		{ module: USE_MODULE, line: 4, column: 26, name: "Port", role: "typeUse", holder: HELD, topLevel: HANDLER },
		{ module: USE_MODULE, line: 7, column: 11, name: "Port", role: "typeUse" },
		// The outline holds it and its id names a withheld module, so the top level stands alone.
		{
			module: USE_MODULE,
			line: 3,
			column: 32,
			name: "Port",
			role: "implements",
			holder: CLOAKED,
			topLevel: HANDLER,
		},
		// A withheld top level leaves the holder, and counts the row at file level.
		{
			module: USE_MODULE,
			line: 7,
			column: 37,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: CLOAKED,
		},
	],
};

const targetStatuses: FacetCase = {
	name: "targets group by target when bound and by spelling when not, ambiguous kept as it stands",
	modules: [useFile, portFile, sealFile, envFile],
	symbols: [...useSymbols, ...portSymbols, ...sealSymbols, otherPort, secret],
	subject: HANDLER,
	uses: [
		{
			module: PORT_MODULE,
			line: 4,
			column: 15,
			name: "Handler",
			role: "typeUse",
			holder: PORT_OPEN,
			topLevel: PORT,
		},
	],
	targets: [
		{
			module: USE_MODULE,
			line: 4,
			column: 13,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
			status: "bound",
			target: PORT,
		},
		{
			module: USE_MODULE,
			line: 4,
			column: 26,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
			status: "bound",
			target: PORT,
		},
		// Another declaration under the same spelling, so a group keyed by spelling would swallow it.
		{
			module: USE_MODULE,
			line: 3,
			column: 40,
			name: "Port",
			role: "typeUse",
			holder: HANDLER,
			topLevel: HANDLER,
			status: "bound",
			target: OTHER_PORT,
		},
		// The same declaration under another spelling, which the bound group takes in.
		{
			module: USE_MODULE,
			line: 3,
			column: 26,
			name: "Gate",
			role: "typeUse",
			holder: HANDLER,
			topLevel: HANDLER,
			status: "bound",
			target: PORT,
		},
		{
			module: USE_MODULE,
			line: 4,
			column: 20,
			name: "Promise",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
			status: "unbound",
			reason: "ExternalDependency",
		},
		{
			module: USE_MODULE,
			line: 4,
			column: 34,
			name: "Promise",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
			status: "unbound",
			reason: "ExternalDependency",
		},
		{
			module: USE_MODULE,
			line: 5,
			column: 1,
			name: "Emit",
			role: "typeUse",
			holder: HANDLER,
			topLevel: HANDLER,
			status: "ambiguous",
		},
		{
			module: USE_MODULE,
			line: 3,
			column: 7,
			name: "Secret",
			role: "typeUse",
			holder: HANDLER,
			topLevel: HANDLER,
			status: "bound",
			target: SECRET,
		},
	],
};

const countsAfterFilter: FacetCase = {
	name: "every count is taken after the filter, never from what the index answered",
	modules: [portFile, useFile, sealFile, envFile],
	symbols: [...portSymbols, ...useSymbols, ...sealSymbols, secret, cloaked],
	subject: PORT,
	uses: [
		{
			module: USE_MODULE,
			line: 4,
			column: 13,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
		},
		{ module: ENV_MODULE, line: 1, column: 0, name: "Port", role: "typeUse", holder: SECRET, topLevel: SECRET },
		{ module: SEAL_MODULE, line: 2, column: 1, name: "Port", role: "typeUse", holder: CLOAKED, topLevel: CLOAKED },
		{ module: ENV_MODULE, line: 1, column: 0, name: "Port", role: "read" },
	],
	targets: [
		{
			module: PORT_MODULE,
			line: 4,
			column: 15,
			name: "Handler",
			role: "typeUse",
			holder: PORT_OPEN,
			topLevel: PORT,
			status: "bound",
			target: HANDLER,
		},
		{
			module: PORT_MODULE,
			line: 4,
			column: 24,
			name: "Secret",
			role: "typeUse",
			holder: PORT_OPEN,
			topLevel: PORT,
			status: "bound",
			target: SECRET,
		},
	],
	members: [PORT_OPEN, CLOAKED],
	hierarchy: {
		supertypes: [
			{ name: "Sealing", symbol: SEALING },
			{ name: "Secret", symbol: SECRET },
		],
		ancestors: [CONTENT, SECRET],
		subtypes: [
			{ name: "Port", symbol: HANDLER },
			{ name: "Port", symbol: SECRET },
		],
	},
	comments: [
		{ module: PORT_MODULE, line: 1, text: "What a port opens onto.", form: "leading", anchor: PORT },
		{ module: PORT_MODULE, line: 3, text: "Opens it.", form: "leading", anchor: PORT_OPEN },
	],
	commentTotal: 9,
};

const bulkAndSecrets: FacetCase = {
	name: "bulk under node_modules is served and counted; a secret .env leaf is dropped and counted nowhere",
	modules: [portFile, vendorFile, envLeafFile],
	symbols: [...portSymbols, vendored, envBacked],
	subject: PORT,
	uses: [
		{
			module: VENDOR_MODULE,
			line: 1,
			column: 33,
			name: "Port",
			role: "implements",
			holder: VENDORED,
			topLevel: VENDORED,
		},
		{
			module: ENV_LEAF_MODULE,
			line: 1,
			column: 34,
			name: "Port",
			role: "implements",
			holder: ENV_BACKED,
			topLevel: ENV_BACKED,
		},
	],
	members: [PORT_OPEN],
	hierarchy: {
		subtypes: [
			{ name: "Port", symbol: VENDORED, role: "implements" },
			{ name: "Port", symbol: ENV_BACKED, role: "implements" },
		],
	},
};

const truncatedPage: FacetCase = {
	name: "a truncated reference page refuses the drill-in whole, counts the page's served rows and opens no file",
	modules: [portFile, useFile, envFile],
	symbols: [...portSymbols, ...useSymbols, secret],
	subject: PORT,
	usePage: 3,
	targetPage: 2,
	uses: [
		{
			module: USE_MODULE,
			line: 4,
			column: 13,
			name: "Port",
			role: "typeUse",
			holder: HANDLER_START,
			topLevel: HANDLER,
		},
		{
			module: USE_MODULE,
			line: 3,
			column: 32,
			name: "Port",
			role: "implements",
			holder: HANDLER,
			topLevel: HANDLER,
		},
		// Past the file's end, and still counted, since a refused answer opens no file.
		{ module: PORT_MODULE, line: 99, column: 1, name: "Port", role: "typeUse", holder: PORT_OPEN, topLevel: PORT },
		{ module: ENV_MODULE, line: 1, column: 0, name: "Port", role: "typeUse", holder: SECRET, topLevel: SECRET },
		{ module: USE_MODULE, line: 7, column: 11, name: "Port", role: "typeUse" },
	],
	targets: [
		{
			module: PORT_MODULE,
			line: 5,
			column: 8,
			name: "Promise",
			role: "typeUse",
			holder: PORT_CLOSE,
			topLevel: PORT,
			status: "unbound",
			reason: "ExternalDependency",
		},
		{
			module: PORT_MODULE,
			line: 4,
			column: 15,
			name: "Handler",
			role: "typeUse",
			holder: PORT_OPEN,
			topLevel: PORT,
			status: "bound",
			target: HANDLER,
		},
		{
			module: PORT_MODULE,
			line: 2,
			column: 20,
			name: "Secret",
			role: "typeUse",
			holder: PORT,
			topLevel: PORT,
			status: "bound",
			target: SECRET,
		},
		{
			module: PORT_MODULE,
			line: 4,
			column: 24,
			name: "Port",
			role: "typeUse",
			holder: PORT_OPEN,
			topLevel: PORT,
			status: "bound",
			target: PORT,
		},
	],
	members: [PORT_OPEN],
};

export const FACET_CASES: FacetCase[] = [
	withheldRows,
	supertypeCount,
	ownComment,
	commentPage,
	holderFallback,
	targetStatuses,
	countsAfterFilter,
	bulkAndSecrets,
	truncatedPage,
];
