package com.atelier_nyaarium.switchboard

import java.util.Locale

/**
 * The files the sandbox answers from: their text, their symbols, and a lexer good enough to paint
 * them. One canned module per path, since one outline served for every file hides every grouping
 * bug at once.
 */

internal data class SandboxSymbol(
	val symbolId: String,
	val name: String,
	val kind: String,
	val startLine: Long,
	val endLine: Long,
	val containerId: String? = null,
	val signature: String? = null,
)

internal data class SandboxModule(
	val path: String,
	val language: String,
	val lines: List<String>,
	val symbols: List<SandboxSymbol>,
	val tracked: Boolean = true,
) {
	val text: String get() = lines.joinToString("\n")

	fun lineAt(line: Long): String = lines.getOrElse((line - 1).toInt()) { "" }

	fun symbol(name: String): SandboxSymbol? = symbols.firstOrNull { it.name == name }

	fun byId(symbolId: String): SandboxSymbol? = symbols.firstOrNull { it.symbolId == symbolId }

	/** Its outermost container, which is what a use row groups under. */
	fun topLevel(symbol: SandboxSymbol): SandboxSymbol {
		var at = symbol
		repeat(symbols.size) {
			val container = at.containerId ?: return at
			at = symbols.firstOrNull { it.symbolId == container } ?: return at
		}
		return at
	}

	fun members(symbol: SandboxSymbol): List<SandboxSymbol> = symbols.filter { it.containerId == symbol.symbolId }

	/** The symbol a line sits in, innermost first. */
	fun holderAt(line: Long): SandboxSymbol? =
		symbols.filter { line >= it.startLine && line <= it.endLine }.minByOrNull { it.endLine - it.startLine }

	fun startingAt(line: Long): SandboxSymbol? = symbols.firstOrNull { it.startLine == line }
}

internal fun sandboxSymbolId(language: String, path: String, chain: String): String = "lexicon $language $path $chain."

////////////////////////////////
//  Lexer

private val CODE_KEYWORDS = setOf(
	"abstract", "as", "async", "await", "break", "case", "catch", "class", "companion", "const", "constructor",
	"continue", "data", "delete", "do", "else", "enum", "export", "extends", "for", "fun", "function", "if",
	"implements", "import", "in", "instanceof", "interface", "internal", "is", "let", "object", "open", "operator",
	"override", "private", "protected", "public", "readonly", "return", "sealed", "static", "struct", "suspend",
	"switch", "this", "throw", "try", "type", "typeof", "val", "var", "void", "when", "while",
)

private val CODE_LITERALS = setOf("true", "false", "null", "undefined")

/** Colours the canned files. Not a parser. */
internal fun sandboxSpans(language: String, line: String): List<Long> {
	val spans = mutableListOf<Long>()
	var at = 0
	while (at < line.length) {
		val ch = line[at]
		when {
			ch == '/' && at + 1 < line.length && (line[at + 1] == '/' || line[at + 1] == '*') -> {
				spans += triple(at, line.length - at, CodeToken.COMMENT)
				at = line.length
			}
			ch == '"' || ch == '\'' -> {
				val end = quoteEnd(line, at, ch)
				spans += triple(at, end - at, CodeToken.STRING)
				at = end
			}
			ch.isDigit() -> {
				val end = wordEnd(line, at)
				spans += triple(at, end - at, CodeToken.NUMBER)
				at = end
			}
			ch.isLetter() || ch == '_' -> {
				val end = wordEnd(line, at)
				tokenOf(line.substring(at, end), line.getOrNull(end))?.let { spans += triple(at, end - at, it) }
				at = end
			}
			else -> at++
		}
	}
	return spans
}

private fun tokenOf(word: String, next: Char?): CodeToken? =
	when {
		word in CODE_LITERALS -> CodeToken.LITERAL
		word in CODE_KEYWORDS -> CodeToken.KEYWORD
		next == '(' -> CodeToken.FUNCTION
		word[0].isUpperCase() -> CodeToken.TYPE
		else -> null
	}

private fun triple(start: Int, length: Int, token: CodeToken): List<Long> =
	listOf(start.toLong(), length.toLong(), token.ordinal.toLong())

private fun wordEnd(line: String, from: Int): Int {
	var at = from
	while (at < line.length && (line[at].isLetterOrDigit() || line[at] == '_')) at++
	return at
}

private fun quoteEnd(line: String, from: Int, quote: Char): Int {
	var at = from + 1
	while (at < line.length) {
		if (line[at] == '\\') at++ else if (line[at] == quote) return at + 1
		at++
	}
	return line.length
}

////////////////////////////////
//  Paths

internal const val SESSION_MODULE = "src/mcp/local/localAgentSession.ts"

internal const val HANDLERS_MODULE = "src/mcp/local/localAgentHandlers.ts"

internal const val CHILD_MODULE = "src/mcp/local/localChildSession.ts"

internal const val CODEX_MODULE = "src/mcp/local/codexLocalSession.ts"

internal const val COPILOT_MODULE = "src/mcp/local/copilotLocalSession.ts"

internal const val PUBLICATION_MODULE = "src/__tests__/local-agent-publication.test.ts"

internal const val HOST_MODULE = "src/mcp/local/localAgentHost.ts"

internal const val RUNTIME_MODULE = "src/mcp/local/localAgentRuntime.ts"

internal const val IDENTITY_MODULE = "src/shared/codexAgentIdentity.ts"

internal const val MUTATE_MODULE = "src/mcp/workspace/mutateFile.ts"

internal const val HUB_MODULE = "src/hub/hub.ts"

internal const val SEALING_MODULE = "android/app/src/main/java/com/atelier_nyaarium/switchboard/crypto/ContentSealing.kt"

internal const val VAULT_SEALING_MODULE = "android/app/src/main/java/com/atelier_nyaarium/switchboard/vault/VaultSealing.kt"

internal const val BOARD_SEALING_MODULE = "android/app/src/main/java/com/atelier_nyaarium/switchboard/board/BoardSealing.kt"

internal const val UNTRACKED_MODULE = "scratch/probe.ts"

/** A secret by its name alone: its uses are dropped before any row or count, as the plugin drops them. */
internal const val WITHHELD_MODULE = "src/config/.env.ts"

/** Bulk rather than secrets: served when named, hidden from a listing. */
internal const val UNLISTED_MODULE = "node_modules/local-agent/index.ts"

private const val TS = "typescript"

private const val KT = "kotlin"

////////////////////////////////
//  Builders

private fun filled(count: Int, vararg at: Pair<Int, String>): List<String> {
	val named = at.toMap()
	return (1..count).map { named[it] ?: "" }
}

private fun from(first: Int, vararg text: String): Array<Pair<Int, String>> = Array(text.size) { first + it to text[it] }

private class Symbols(private val path: String, private val language: String) {
	val all = mutableListOf<SandboxSymbol>()

	fun add(
		name: String,
		kind: String,
		startLine: Long,
		endLine: Long = startLine,
		container: SandboxSymbol? = null,
		signature: String? = null,
	): SandboxSymbol {
		val chain = container?.let { "${it.name}:$name" } ?: name
		val symbol = SandboxSymbol(
			symbolId = sandboxSymbolId(language, path, chain),
			name = name,
			kind = kind,
			startLine = startLine,
			endLine = endLine,
			containerId = container?.symbolId,
			signature = signature,
		)
		all += symbol
		return symbol
	}
}

private fun module(
	path: String,
	language: String,
	lines: List<String>,
	tracked: Boolean = true,
	build: Symbols.() -> Unit,
): SandboxModule {
	val symbols = Symbols(path, language).apply(build)
	return SandboxModule(path = path, language = language, lines = lines, symbols = symbols.all, tracked = tracked)
}

////////////////////////////////
//  Modules

private fun localAgentSession() = module(
	SESSION_MODULE,
	TS,
	filled(
		43,
		*from(
			1,
			"import type { CodexServiceTier } from \"../../shared/codexAgentIdentity.js\";",
			"",
			"/** The handle a turn is followed through. */",
		),
		*from(
			20,
			"export interface LocalTurnHandle {",
			"\treadonly turnId: string;",
			"\treadonly threadId: string;",
			"\twait(): Promise<void>;",
			"}",
			"/** One backend's live session, whatever runs underneath it. */",
			"export interface LocalBackendSession {",
			"\t/** The working directory is fixed here for the thread's life. */",
			"\topenThread(options: { cwd: string; model?: string; serviceTier?: CodexServiceTier }): Promise<string>;",
			"\t/** A backend without service tiers ignores `turn`. `model` is the thread's, for the tier check. */",
			"\tstartTurn(",
			"\t\tthreadId: string,",
			"\t\tprompt: string,",
			"\t\tturn?: { model?: string; serviceTier?: CodexServiceTier },",
			"\t): Promise<LocalTurnHandle>;",
			"\t/** Absent on a backend with no steer, making \"cannot follow up while working\" a type-level fact. */",
			"\tsteerTurn?(threadId: string, turnId: string, prompt: string): Promise<void>;",
			"\tinterruptTurn(threadId: string, turnId: string): Promise<void>;",
			"\t/** Text only: the runtime caps and numbers what it keeps. */",
			"\tonActivity(listener: (turnId: string, text: string) => void): void;",
			"\t/** Load-bearing: the runtime caches the session, so a dead child would stay cached forever. */",
			"\tonClosed(listener: () => void): void;",
			"\tclose(): void;",
			"}",
		),
	),
) {
	add("LocalTurnHandle", "interface", 20, 24)
	val session = add("LocalBackendSession", "interface", 26, 43)
	add(
		"openThread",
		"method",
		28,
		container = session,
		signature = "(options: { cwd: string; model?: string; serviceTier?: CodexServiceTier }): Promise<string>",
	)
	add(
		"startTurn",
		"method",
		30,
		34,
		session,
		"(threadId: string, prompt: string, turn?: { model?: string; serviceTier?: CodexServiceTier }): " +
			"Promise<LocalTurnHandle>",
	)
	add("steerTurn", "method", 36, container = session, signature = "(threadId: string, turnId: string, prompt: string): Promise<void>")
	add("interruptTurn", "method", 37, container = session, signature = "(threadId: string, turnId: string): Promise<void>")
	add("onActivity", "method", 39, container = session, signature = "(listener: (turnId: string, text: string) => void): void")
	add("onClosed", "method", 41, container = session, signature = "(listener: () => void): void")
	add("close", "method", 42, container = session, signature = "(): void")
}

private fun localAgentHandlers() = module(
	HANDLERS_MODULE,
	TS,
	filled(
		230,
		*from(
			16,
			"export interface LocalHandlerHost {",
			"\treadonly spec: LocalBackendSpec;",
			"\tnow(): number;",
			"\topen(): Promise<LocalBackendSession>;",
			"}",
		),
		*from(61, "export class LocalAgentHandlers {"),
		*from(
			93,
			"\tasync start(request: LocalRequest): Promise<LocalAgentAnswer> {",
			"\t\t// Preserve a caller-supplied operation identity for agent derivation.",
			"\t\tconst operationId = request.operationId ?? crypto.randomUUID();",
			"\t\tconst agentId = agentIdForOperation(this.host.spec.backendId, operationId);",
			"\t\tconst prompt = request.prompt ?? \"\";",
			"",
			"\t\tlet session: LocalBackendSession;",
			"\t\ttry {",
			"\t\t\tsession = await this.host.open();",
			"\t\t} catch (error) {",
			"\t\t\treturn this.fail(agentId, \"app_server_unavailable\", errorText(error), true);",
			"\t\t}",
			"",
			"\t\tconst createdAt = this.host.now();",
			"\t\tlet threadId: string;",
			"\t\ttry {",
			"\t\t\tthreadId = await session.openThread({",
			"\t\t\t\tcwd: request.cwd ?? this.host.spec.defaultCwd(),",
			"\t\t\t\tmodel: request.model,",
			"\t\t\t\tserviceTier: request.serviceTier,",
			"\t\t\t});",
			"\t\t} catch (error) {",
			"\t\t\treturn this.fail(agentId, \"thread_refused\", errorText(error), true);",
			"\t\t}",
			"",
			"\t\tconst agent = this.record(agentId, session, threadId, createdAt);",
			"\t\tthis.agents.set(agentId, agent);",
			"",
			"\t\tconst turn = await this.dispatchTurn({ agent, prompt, session });",
			"\t\tif (!turn.ok) {",
			"\t\t\treturn this.fail(agentId, turn.reason, turn.text, false);",
			"\t\t}",
			"",
			"\t\treturn {",
			"\t\t\tagentId,",
			"\t\t\tstatus: \"working\",",
			"\t\t};",
			"\t}",
		),
		*from(132, "\tasync message(request: LocalRequest): Promise<LocalAgentAnswer> {"),
		*from(136, "\t\tlet session: LocalBackendSession;"),
		*from(182, "\tasync stop(agentId: string): Promise<void> {"),
		*from(186, "\t\tlet session: LocalBackendSession;"),
		*from(
			220,
			"\tprivate async dispatchTurn(work: {",
			"\t\tagent: LocalAgent,",
			"\t\tprompt: string,",
			"\t\tsession: LocalBackendSession,",
			"\t}): Promise<TurnOutcome> {",
			"\t\tconst handle = await work.session.startTurn(work.agent.threadId, work.prompt);",
			"\t\treturn { ok: true, handle };",
			"\t}",
			"}",
		),
	),
) {
	val host = add("LocalHandlerHost", "interface", 16, 20)
	add("open", "method", 19, container = host, signature = "(): Promise<LocalBackendSession>")
	val handlers = add("LocalAgentHandlers", "class", 61, 228)
	add("start", "method", 93, 130, handlers, "(request: LocalRequest): Promise<LocalAgentAnswer>")
	add("message", "method", 132, 180, handlers, "(request: LocalRequest): Promise<LocalAgentAnswer>")
	add("stop", "method", 182, 200, handlers, "(agentId: string): Promise<void>")
	add("dispatchTurn", "method", 220, 227, handlers, "(work: { agent: LocalAgent; prompt: string; session: LocalBackendSession }): Promise<TurnOutcome>")
}

private fun localChildSession() = module(
	CHILD_MODULE,
	TS,
	filled(
		60,
		*from(
			13,
			"const LOCAL_IDLE_REAP_MS = 5 * 60_000;",
			"",
			"export class LocalChildSession {",
			"\tprivate session?: LocalBackendSession;",
			"\tprivate opening?: Promise<LocalBackendSession>;",
		),
		*from(
			40,
			"\topen(): Promise<LocalBackendSession> {",
			"\t\tif (this.session) return Promise.resolve(this.session);",
			"\t\tthis.opening ??= this.spawn();",
			"\t\tthis.armReap(LOCAL_IDLE_REAP_MS);",
			"\t\treturn this.opening;",
			"\t}",
		),
	),
) {
	add("LOCAL_IDLE_REAP_MS", "constant", 13, signature = "= 5 * 60_000")
	val child = add("LocalChildSession", "class", 15, 60)
	add("session", "property", 16, container = child, signature = "?: LocalBackendSession")
	add("opening", "property", 17, container = child, signature = "?: Promise<LocalBackendSession>")
	add("open", "method", 40, 45, child, "(): Promise<LocalBackendSession>")
}

private fun localAgentRuntime() = module(
	RUNTIME_MODULE,
	TS,
	filled(
		90,
		*from(8, "const reapAfter = LOCAL_IDLE_REAP_MS;"),
		*from(
			48,
			"export interface LocalBackendSpec {",
			"\treadonly backendId: string;",
			"\topenSession(): Promise<LocalBackendSession>;",
		),
		*from(
			75,
			"export function reapIdle(sessions: Map<string, LocalChildSession>): void {",
			"\tconst now = Date.now();",
			"\tfor (const [id, session] of sessions) {",
			"\t\tif (now - session.idleSince < reapAfter) continue;",
			"\t\tsession.close(LOCAL_IDLE_REAP_MS);",
			"\t\tsessions.delete(id);",
			"\t}",
			"}",
		),
	),
) {
	val spec = add("LocalBackendSpec", "interface", 48, 60)
	add("backendId", "property", 49, container = spec, signature = ": string")
	add("openSession", "method", 50, container = spec, signature = "(): Promise<LocalBackendSession>")
	add("reapIdle", "function", 75, 82, signature = "(sessions: Map<string, LocalChildSession>): void")
}

private fun localAgentHost() = module(
	HOST_MODULE,
	TS,
	filled(
		150,
		*from(106, "export function createLocalAgentBackend(spec: LocalBackendSpec): LocalAgentBackend {"),
		*from(
			132,
			"\t\topenSession: async (): Promise<LocalBackendSession> => {",
			"\t\t\treturn new LocalChildSession(spec);",
			"\t\t},",
		),
		*from(140, "\t\tstart: (request) => handlers.start(request),"),
	),
) {
	add("createLocalAgentBackend", "function", 106, 150, signature = "(spec: LocalBackendSpec): LocalAgentBackend")
}

private fun codexLocalSession() = module(
	CODEX_MODULE,
	TS,
	filled(
		80,
		*from(
			20,
			"export class CodexLocalSession implements LocalBackendSession {",
			"\tconstructor(private readonly target: CodexTarget) {}",
		),
	),
) {
	add("CodexLocalSession", "class", 20, 80)
}

private fun copilotLocalSession() = module(
	COPILOT_MODULE,
	TS,
	filled(
		90,
		*from(
			29,
			"export class CopilotLocalSession implements LocalBackendSession {",
			"\tconstructor(private readonly child: CopilotChild) {}",
		),
	),
) {
	add("CopilotLocalSession", "class", 29, 90)
}

private fun publicationTest() = module(
	PUBLICATION_MODULE,
	TS,
	filled(
		40,
		*from(
			19,
			"class ValueBackendAdapter implements LocalBackendSession {",
			"\tconstructor(private readonly answers: string[]) {}",
		),
	),
) {
	add("ValueBackendAdapter", "class", 19, 40)
}

private fun codexAgentIdentity() = module(
	IDENTITY_MODULE,
	TS,
	filled(
		130,
		*from(
			121,
			"/** What a turn is charged at. */",
			"export type CodexServiceTier = \"priority\" | \"standard\";",
		),
	),
) {
	add("CodexServiceTier", "type", 122, signature = "= \"priority\" | \"standard\"")
}

private fun mutateFile() = module(
	MUTATE_MODULE,
	TS,
	filled(
		70,
		*from(
			47,
			"export class SourceMoved extends Error {",
			"\tconstructor(readonly path: string) {",
			"\t\tsuper(`\${path} moved while it was being written`);",
			"\t}",
			"}",
		),
	),
) {
	add("SourceMoved", "class", 47, 51)
}

private fun contentSealing() = module(
	SEALING_MODULE,
	KT,
	filled(
		60,
		*from(
			12,
			"interface Sealing {",
			"\tfun seal(epoch: String, text: String): SealedText",
			"}",
		),
		*from(
			18,
			"open class ContentSealing(private val keyring: ContentKeyring) : Sealing {",
			"\tprotected open fun aad(epoch: String): ByteArray = epoch.toByteArray()",
			"",
			"\toverride fun seal(epoch: String, text: String): SealedText {",
			"\t\tval key = keyring.keyFor(epoch)",
			"\t\treturn SealedText(key.seal(text.toByteArray(), aad(epoch)))",
			"\t}",
			"}",
		),
	),
) {
	add("Sealing", "interface", 12, 14)
	val sealing = add("ContentSealing", "class", 18, 25)
	add("aad", "method", 19, container = sealing, signature = "(epoch: String): ByteArray")
	add("seal", "method", 21, 24, sealing, "(epoch: String, text: String): SealedText")
}

private fun vaultSealing() = module(
	VAULT_SEALING_MODULE,
	KT,
	filled(
		50,
		*from(
			14,
			"class VaultSealing(keyring: ContentKeyring) : ContentSealing(keyring) {",
			"\toverride fun aad(epoch: String): ByteArray = vaultAad(epoch)",
			"}",
		),
	),
) {
	add("VaultSealing", "class", 14, 16)
}

private fun boardSealing() = module(
	BOARD_SEALING_MODULE,
	KT,
	filled(
		44,
		*from(
			11,
			"class BoardSealing(keyring: ContentKeyring) : ContentSealing(keyring) {",
			"\toverride fun aad(epoch: String): ByteArray = boardTextAad(epoch, entryId)",
			"}",
		),
	),
) {
	add("BoardSealing", "class", 11, 13)
}

private fun vendored() = module(
	UNLISTED_MODULE,
	TS,
	filled(
		12,
		*from(
			6,
			"export class VendoredSession implements LocalBackendSession {",
			"\tconstructor(private readonly inner: unknown) {}",
			"}",
		),
	),
) {
	add("VendoredSession", "class", 6, 8)
}

/** Real text, so only the withholding rule keeps its use out of a row. */
private fun envConfig() = module(
	WITHHELD_MODULE,
	TS,
	filled(
		10,
		*from(
			4,
			"export class EnvBackedSession implements LocalBackendSession {",
			"\tconstructor(private readonly token: string) {}",
			"}",
		),
	),
) {
	add("EnvBackedSession", "class", 4, 6)
}

private fun probe() = module(
	UNTRACKED_MODULE,
	TS,
	filled(
		12,
		*from(
			3,
			"export function probe(input: string): string {",
			"\treturn input.trim().toLowerCase();",
			"}",
		),
	),
	tracked = false,
) {
	add("probe", "function", 3, 5, signature = "(input: string): string")
}

////////////////////////////////
//  Hub

internal fun hubUserPath(index: Int): String = "src/hub/users/user%02d.ts".format(Locale.ROOT, index)

/** Not every file the same size, or a count that dropped a file would still add up. */
internal fun hubUseCount(index: Int): Int = if (index <= 30) 14 else 13

internal fun hubUseLine(at: Int): Long = 10L + at * 3

/** The tenth file opens at module level, so a use with no holder has somewhere to draw. */
internal fun hubHolderName(index: Int, at: Int): String? =
	if (at == 0 && index % 10 == 0) null else "user%02dStep%d".format(Locale.ROOT, index, minOf(2, at / 5))

internal val HUB_USER_INDICES: IntRange = 1..90

private fun hubUser(index: Int): SandboxModule {
	val path = hubUserPath(index)
	val uses = (0 until hubUseCount(index)).map { at ->
		hubUseLine(at).toInt() to "\tconst v$at = hubEvent(input$at);"
	}
	return module(path, TS, filled(55, *from(1, "import { hubEvent } from \"../hub.js\";"), *uses.toTypedArray())) {
		add("user%02dStep0".format(Locale.ROOT, index), "function", 9, 23, signature = "(input: HubInput): void")
		add("user%02dStep1".format(Locale.ROOT, index), "function", 24, 38, signature = "(input: HubInput): void")
		add("user%02dStep2".format(Locale.ROOT, index), "function", 39, 51, signature = "(input: HubInput): void")
	}
}

private fun hub() = module(
	HUB_MODULE,
	TS,
	filled(
		120,
		*from(
			12,
			"export function hubEvent(input: HubInput): HubEvent {",
			"\treturn { at: Date.now(), input };",
			"}",
		),
		*from(40, "export class HubRegistry {"),
	),
) {
	add("hubEvent", "function", 12, 14, signature = "(input: HubInput): HubEvent")
	add("HubRegistry", "class", 40, 120)
}

////////////////////////////////
//  The set

/** Every folder the canned paths sit in, so the tree walks down to them. */
internal fun sandboxFolders(paths: Iterable<String>): List<String> =
	paths.flatMap { path ->
		val parts = path.split('/').dropLast(1)
		parts.indices.map { parts.take(it + 1).joinToString("/") }
	}.distinct()

internal fun sandboxModules(): Map<String, SandboxModule> {
	val named = listOf(
		localAgentSession(),
		localAgentHandlers(),
		localChildSession(),
		localAgentRuntime(),
		localAgentHost(),
		codexLocalSession(),
		copilotLocalSession(),
		publicationTest(),
		codexAgentIdentity(),
		mutateFile(),
		contentSealing(),
		vaultSealing(),
		boardSealing(),
		vendored(),
		envConfig(),
		probe(),
		hub(),
	) + HUB_USER_INDICES.map(::hubUser)
	return named.associateBy { it.path }
}
