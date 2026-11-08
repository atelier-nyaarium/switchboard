////////////////////////////////
//  Interfaces & Types

export interface LimitNotice {
	/** The matched headline, rejoined across wrap rows. Null when it has already scrolled off the pane,
	 * which is common: the dialog is pinned to the bottom and the transcript above it is whatever was
	 * on screen. Never load-bearing - the dialog itself is what proves the session is blocked. */
	headline: string | null;
	/** Everything after the headline's first middle dot, e.g. "resets 5pm". Null without a headline. */
	detail: string | null;
}

////////////////////////////////
//  Functions & Helpers

// Pure classifiers over a captured tmux pane: what state the agent's REPL screen shows. The daemon's
// wake/readiness path reaches them through tmuxCore.ts's re-export; presenceScheduler.ts imports this
// module directly, so a consumer sweep has to check both. The Kotlin twin lives in
// android/.../AgentScreen.kt - keep the markers in lockstep, and delete on both sides together: a
// classifier here costs a matching one there whether or not anything calls it.

// The composer glyph. Linux Claude draws "❯" U+276F; the WINDOWS build draws ">" U+003E. Same binary
// version on the same machine renders both, so this is the build's own difference and not version
// drift - an enumeration of the two, not a guess at a range.
const COMPOSER_GLYPH = "[❯>]";
// The ready composer prompt, anchored at the start of the region it sits in. The dev-channels /
// folder-trust / resume-picker menus show an INDENTED cursor ("  ❯ 1."), so the anchor matches the
// real composer and never a menu line. Applied per line, and per post-rule remainder: see
// isAgentReady for why the composer is not always at column 0.
const COMPOSER_RE = new RegExp(`^${COMPOSER_GLYPH}`, "u");
// Dim prompt is placeholder.
function withoutDimText(line: string): string {
	const start = line.indexOf("\x1b[2m");
	if (start < 0) return line;
	const reset = line.indexOf("\x1b[0m", start);
	return line.slice(0, start) + (reset < 0 ? "" : line.slice(reset + 4));
}
const COMPOSER_EMPTY_RE = new RegExp(`^${COMPOSER_GLYPH}[ \\t\\u00a0]*\\r?$`, "u");
// Whitespace as an EXPLICIT class, never \s. The Windows build emits U+00A0 after the glyph, and JS's
// \s matches it while the JVM's default does not - so \s here would make the Kotlin twin disagree on a
// real frame, silently, in the one direction no fixture currently covers. Spelled out, both languages
// read the same set.
const SPACE = "[ \\t\\u00a0]";
// The "esc to interrupt" hint in the bottom toolbar, always preceded by a middle-dot separator.
//
// Necessary and NOT sufficient, which is the whole reason for the status-line rule below. The
// toolbar elides its own tail to "· …" when the pane is too narrow for it, and the mode label is
// part of that width: "bypass permissions on" is long enough to push this off a pane where "auto
// mode on" left it visible. Every working fixture in the corpus was captured in auto mode, so the
// corpus cannot see that at all.
// Toolbar only. Prose-shaped, so a transcript tail in the status rows would trip it.
const WORKING_HINT_RE = /· esc/u;

// Copilot's busy footer: "◎ Working · 470 B esc interrupt"; 1.0.106 says "ctrl+c interrupt".
const COPILOT_WORKING_RE = /\bWorking\b[^\n]*\b(?:esc|ctrl\+c) interrupt\b/u;

// Status line token run: "✶ Composing… (46m 51s · ↓ 154.1k tokens)".
const WORKING_STATUS_RE = /\(\d+[hms][^()]*tokens\)/u;

// Spinner frames. A new frame falls back to idle, never to busy.
const SPINNER = "[·✢✳✶✻✽*]";
// Spinner, any verb, ellipsis before a bracket.
const RUNNING_ROW_RE = new RegExp(`^${SPINNER}${SPACE}+[^ \\t\\u00a0()…\\n\\r]+(?:…|${SPACE}[^()\\n]*…)`, "mu");
// Unfinished workflow row.
const WORKFLOW_BAR_RE = /◯[^\n]*?(?=[▰▱]{3,})[▰▱]*▱/u;
// A full bar still running: "✻ Waiting for 1 dynamic workflow to finish".
const WORKFLOW_WAIT_RE = new RegExp(`^${SPINNER}${SPACE}+Waiting for \\d+ [^\\n]*workflow`, "mu");
// "· Compacting conversation… (10s)"
const COMPACTING_RE = new RegExp(`^${SPINNER}${SPACE}+Compacting conversation`, "mu");
// Tip and meter rows sit below it.
const COMPACTING_LOOKBACK = 8;

/** Claude's status-line notice once its auto-update installed. */
const UPDATE_INSTALLED_RE = /Update installed/u;
// Teammate row: dot, name, then more. Bare "● main" excluded.
const TEAMMATE_ROW_RE = new RegExp(`^${SPACE}*[●◯]${SPACE}+[^ \\t\\u00a0]+${SPACE}+[^ \\t\\u00a0]`, "u");
const TEAMMATE_IDLE_RE = new RegExp(`${SPACE}idle${SPACE}*$`, "u");
const METER_RE = /[▰▱]/u;

/**
 * How far above the composer's top rule the status line may sit.
 *
 * It is drawn immediately above the rule with at most a blank row between, so 3 covers what has been
 * observed; 5 is the owner's call, two rows of slack against a layout that shifts again. The bound
 * matters more than its exact value - unbounded means reading the transcript, which is precisely what
 * scoping regions in this module exists to prevent.
 */
const STATUS_LOOKBACK = 5;
// The auth notice renders in both slices and needs a different rule in each.
// Unanchored: in the toolbar it shares the mode label's line.
const LOGGED_OUT_TOOLBAR_RE = /Not logged in|Run \/login/;
// Anchored: above the composer it is a row of its own, and that slice holds the transcript tail,
// where prose about logging in would otherwise match. SPACE, never `\s`: the JVM excludes U+00A0.
const LOGGED_OUT_STATUS_RE = new RegExp(`^${SPACE}*(?:Not logged in|Run /login)\\b`, "mu");

// A rule RUN, not a rule LINE, and the reason this module has a primitive at all.
//
// `capture-pane -J` joins a row tmux marked as wrapped onto its neighbour. On Windows-hosted panes it
// joins the composer's rules onto the rows beside them, so a rule is NOT reliably a line of its own:
// the top rule arrives welded to the composer row (always), and the bottom rule welded to the footer
// (after a resize - and `peekPane` resizes on every peek, so the wake path induces it deliberately).
// Two notions, kept distinct because they are not interchangeable: TOOLBAR is the composer's own
// boundary and is U+2500 only, while ANY covers any divider including the limit dialog's U+2594 block
// element. Runs of 3+, so a lone dash in prose is not a boundary.
const TOOLBAR_RUN_RE = /─{3,}/u;
const ANY_RULE_RUN_RE = /[─-▟]{3,}/u;
// The historical divider predicate: the whole trimmed line is rule characters, one or more. Kept
// EXACTLY as it was and tried first, so limitNotice's Linux behaviour is byte-identical - see the
// two-pass search there for why widening it in place was the wrong move.
const ANY_RULE_LINE_RE = /^[─-▟]+$/u;

/**
 * What follows the LAST rule run on a line, or null when the line carries none.
 *
 * Empty string when the run ends the line, which is the ordinary unjoined shape - distinct from null,
 * and the distinction is the point: "" means "a boundary is here and nothing follows it", null means
 * "no boundary on this line at all". The run is not assumed to start the line either; an unresized
 * Windows composer row carries a span of spaces before it.
 */
function afterRuleRun(line: string, runRe: RegExp): string | null {
	let after: string | null = null;
	const scan = new RegExp(runRe.source, "gu");
	for (let match = scan.exec(line); match !== null; match = scan.exec(line)) {
		after = line.slice(match.index + match[0].length);
	}
	return after;
}

/**
 * The region a footer reader may look at: whatever follows the last toolbar rule run, plus every line
 * below it. The one place that knows a rule can share its line with text.
 *
 * The last-two-lines fallback is for a pane carrying no rule at all - a startup or partial frame - and
 * it is applied UNIFORMLY here, which is a fix in itself. It used to live in isAgentWorking alone,
 * while isLoggedOut computed `slice(lastRule + 1)` with lastRule at -1 and so read `slice(0)`: the
 * ENTIRE screen, transcript included. That is exactly what scoping this region exists to prevent, and
 * it was live on every platform.
 */
function footerRegion(lines: string[]): string[] {
	for (let i = lines.length - 1; i >= 0; i--) {
		const after = afterRuleRun(lines[i], TOOLBAR_RUN_RE);
		if (after !== null) return [after, ...lines.slice(i + 1)];
	}
	return lines.slice(-2);
}

// A rule row for the usage-limit check. Spans Box Drawing AND Block Elements (U+2500-U+259F): the
// limit dialog's own divider is U+2594, a block element, so a Box-Drawing-only range matches nothing
// on a real pane and detection never starts. TITLED_BORDER_RE is the same run leading a row that
// also carries text, which the composer's top border does once a session has a name.
const TITLED_BORDER_RE = /^[─-▟]{3,}/u;
// An INDENTED prompt followed by a numbered option, i.e. a selectable dialog holds the pane. Column 0
// would be the composer, so the leading whitespace is load-bearing.
const MENU_CURSOR_RE = new RegExp(`^${SPACE}+${COMPOSER_GLYPH}${SPACE}*\\d+\\.`, "mu");
// The usage-limit dialog's own cancel choice, matched on the label's stable tail. It collapses to a
// bare "Stop" on usage-based billing, which is too generic to match, so that case is not detected.
const LIMIT_MENU_RE = /wait for limit to reset/;
// Below the toolbar once the session waits for the reset. Anchored so prose cannot match.
const LIMIT_WAITING_RE = new RegExp(
	`^${SPACE}*⚠${SPACE}*(Usage limit reached)${SPACE}*·${SPACE}*([^ \\t\\u00a0].*?)${SPACE}*$`,
	"u",
);
// Deliberately names no model, plan, seat kind, or billing period: those churn, and an enumeration
// fails silently the first time one is renamed. Each branch is a literal prefix of one of the CLI's
// own headline builders, so the variable part stays payload to display rather than something to match.
// The apostrophe slot is \W so a straight or typographic quote both match; the CLI emits ASCII today.
const LIMIT_HEADLINE_RE = new RegExp(
	[
		"You\\Wve (?:hit|reached) your\\b",
		"You\\Wre out of (?:extra )?usage\\b",
		"is out of usage\\b",
		"requires usage credits\\b",
		"seat type doesn\\Wt include\\b",
		"usage allocation has been disabled\\b",
		"usage limit is set to \\$0",
		"This service is disabled for your org\\b",
	].join("|"),
	"u",
);
// Rows to read above the divider. Panes are pinned narrow, where a short reset-time headline
// fits on one row and a long admin/org suffix wraps onto a second or third.
const LIMIT_WINDOW_ROWS = 3;

// capture-pane runs with -e, so the screen carries SGR color escapes. Strip them before matching: an
// escape at the start of a line defeats the composer's ^ anchor, and one splitting a phrase defeats a
// substring check. The Kotlin twin strips the same in AgentScreen.kt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the literal ESC of an ANSI CSI sequence
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(screen: string): string {
	return screen.replace(ANSI_CSI_RE, "");
}

/** Whether a captured pane shows claude at the idle REPL composer, i.e. startup finished (menus
 * cleared, history rendered). The composer prompt sits at column 0; the dev-channels / folder-trust /
 * resume-picker menus show an indented cursor, so the line-start anchor never matches a menu. Both a
 * fresh launch and a resumed session settle here. Used once per wake or fresh spawn to know the
 * session is up; the working/done state (isAgentWorking) takes over after the first message. The
 * Kotlin twin lives in AgentScreen.kt. */
export function isAgentReady(screen: string): boolean {
	return stripAnsi(screen)
		.split("\n")
		.some((line) => {
			// Column 0, the unjoined shape.
			if (COMPOSER_RE.test(line)) return true;
			// Or welded to the rule above it, which is EVERY Windows frame: the top rule and the composer
			// row arrive as one line, so the glyph is never at column 0 there even setting the glyph
			// difference aside. Anchoring on the post-rule remainder keeps menus rejected, since an
			// indented "  ❯ 1." carries its indentation across the join and still fails the anchor.
			const after = afterRuleRun(line, TOOLBAR_RUN_RE);
			return after !== null && COMPOSER_RE.test(after);
		});
}

// Empty composer only.
export function isAgentComposerEmpty(screen: string): boolean {
	const rawLines = screen.split("\n");
	const lines = stripAnsi(screen).split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const afterTopRule = afterRuleRun(line, TOOLBAR_RUN_RE);
		const composer = COMPOSER_RE.test(line)
			? line
			: afterTopRule !== null && COMPOSER_RE.test(afterTopRule)
				? afterTopRule
				: null;
		if (composer === null) continue;

		const hasTopRule =
			afterTopRule !== null ||
			(i > 0 && /^[ \t\u00a0]*$/u.test(afterRuleRun(lines[i - 1]!, TOOLBAR_RUN_RE) ?? "x"));
		const hasBottomRule = lines[i + 1] !== undefined && afterRuleRun(lines[i + 1]!, TOOLBAR_RUN_RE) !== null;
		if (hasTopRule && hasBottomRule) {
			const visible = stripAnsi(withoutDimText(rawLines[i] ?? line));
			const afterVisibleRule = afterRuleRun(visible, TOOLBAR_RUN_RE);
			const visibleComposer = COMPOSER_RE.test(visible) ? visible : afterVisibleRule;
			return visibleComposer !== null && visibleComposer !== undefined && COMPOSER_EMPTY_RE.test(visibleComposer);
		}
	}
	return false;
}

/** Whether a captured pane shows claude working: the "esc to interrupt" hint, an unfinished workflow
 * row or an active teammate below the last rule, or a running turn's status line above the composer.
 * The Kotlin twin lives in AgentScreen.kt. */
export function isAgentWorking(screen: string): boolean {
	// Not one alternation over both slices: each marker is only safe in its own.
	return (
		paneHas(screen, WORKING_HINT_RE, "toolbar") ||
		paneHas(screen, COPILOT_WORKING_RE, "toolbar") ||
		paneHas(screen, WORKING_STATUS_RE, "status") ||
		paneHas(screen, RUNNING_ROW_RE, "status") ||
		hasWorkflow(screen) ||
		hasActiveTeammate(screen)
	);
}

/** A teammate row below the toolbar that is neither idle nor a workflow. Twin: AgentScreen.hasActiveTeammate. */
export function hasActiveTeammate(screen: string): boolean {
	return paneRegion(screen, "toolbar").some(
		(row) => TEAMMATE_ROW_RE.test(row) && !TEAMMATE_IDLE_RE.test(row) && !METER_RE.test(row),
	);
}

/** An unfinished workflow row, or the live line waiting on one. Twin: AgentScreen.hasWorkflow. */
export function hasWorkflow(screen: string): boolean {
	return paneHas(screen, WORKFLOW_BAR_RE, "toolbar") || paneHas(screen, WORKFLOW_WAIT_RE, "status");
}

/** The conversation is compacting. Twin: AgentScreen.isCompacting. */
export function isCompacting(screen: string): boolean {
	return paneHas(screen, COMPACTING_RE, "status", COMPACTING_LOOKBACK);
}

/** The session backends a pane can belong to. */
export type PaneBackend = "claude" | "copilot";

/** Per backend, whether its pane asks for a restart to apply an update; null until its line is known. */
const RESTART_SIGNALS: Record<PaneBackend, ((screen: string) => boolean) | null> = {
	claude: (screen) => paneHas(screen, UPDATE_INSTALLED_RE, "status"),
	copilot: null,
};

/** The pane says an update is installed and waits on a restart. */
export function restartPending(backend: PaneBackend, screen: string): boolean {
	return RESTART_SIGNALS[backend]?.(screen) ?? false;
}

/**
 * The bounded rows just above the composer's TOP rule, where a running turn draws its status line.
 *
 * A different region from `footerRegion`, and it has to be: that one starts at the LAST rule run and
 * reads downward, so it covers the toolbar and everything under it and can never see a line above
 * the composer, where a working session's status line sits while its toolbar elides "esc to
 * interrupt" for want of width.
 *
 * The top rule is found by scanning DOWN for the first toolbar run: the composer's own top border is
 * the first rule on a settled pane, and starting from the bottom would find the lower border instead
 * and put the region inside the composer box.
 */
function statusRegion(lines: string[], lookback: number): string[] {
	for (let i = 0; i < lines.length; i++) {
		if (afterRuleRun(lines[i]!, TOOLBAR_RUN_RE) !== null) {
			return lines.slice(Math.max(0, i - lookback), i);
		}
	}
	// No rule at all: a startup or partial frame. The same last-two-lines fallback the footer uses,
	// so a pane with no composer yet is read the same way by both regions rather than one of them
	// silently reading the whole screen.
	return lines.slice(-2);
}

/** Where a marker may appear. No value spans both, so a "/login" typed in the composer stays inert. */
export type PaneRegion = "toolbar" | "status";

/** The one place a pane is sliced. Stripped rows of one region. */
export function paneRegion(screen: string, where: PaneRegion, lookback = STATUS_LOOKBACK): string[] {
	const lines = stripAnsi(screen).split("\n");
	return where === "toolbar" ? footerRegion(lines) : statusRegion(lines, lookback);
}

function paneHas(screen: string, marker: RegExp, where: PaneRegion, lookback = STATUS_LOOKBACK): boolean {
	return marker.test(paneRegion(screen, where, lookback).join("\n"));
}

/** Whether the captured pane shows claude logged out: it prints "Not logged in" / "Run /login" in its
 * own chrome. Independent of ready/working - a logged-out session still renders the composer, so a
 * caller must check this separately. Detectable at any peek (the notice persists), including a token
 * that expires mid-session. The Kotlin twin lives in AgentScreen.kt. */
export function isLoggedOut(screen: string): boolean {
	return paneHas(screen, LOGGED_OUT_TOOLBAR_RE, "toolbar") || paneHas(screen, LOGGED_OUT_STATUS_RE, "status");
}

/** The usage-limit dialog, i.e. the agent has stopped and cannot progress until the choice is answered.
 * Returns the headline and the text after its middle dot, or null.
 *
 * The DIALOG is the signal, never the headline. Both below-divider markers are required: an indented
 * numbered menu, and that dialog's own wait-for-reset choice. Neither is sufficient alone, since the
 * dialog title is reused by unrelated dialogs and a numbered menu is just as present on a permission
 * prompt, but together they appear nowhere else. Once the choice is answered the menu goes with it, so
 * the notice clears itself with no state to expire.
 *
 * The headline is read only to enrich the notice and is frequently absent: the dialog is pinned to the
 * bottom of the pane, so whatever sits above it is whatever happened to be on screen, and the headline
 * has usually scrolled past. Requiring it missed the common case entirely.
 *
 * The Kotlin twin lives in AgentScreen.kt. */
/** The notice a session waiting out its limit shows. */
function limitWaiting(screen: string): LimitNotice | null {
	for (const row of paneRegion(screen, "toolbar")) {
		const waiting = LIMIT_WAITING_RE.exec(row);
		if (waiting) return { headline: waiting[1], detail: waiting[2] };
	}
	return null;
}

export function limitNotice(screen: string): LimitNotice | null {
	const lines = stripAnsi(screen).split("\n");
	// Lowest divider whose region below carries both signals. Not simply the last rule: a dialog that
	// draws its own bottom border would put that border last, leaving the menu above it unseen.
	// Its OWN loop, not footerRegion: that helper answers "the last toolbar boundary", and this needs
	// the lowest divider whose region below carries both signals, which is not the same line. It also
	// spans the wider rule set.
	//
	// TWO PASSES, strictly ordered, and the order is the whole point. Pass 1 is the historical
	// predicate unchanged, so on any frame that used to resolve, it still resolves to the SAME divider.
	// Widening the predicate in place looked equivalent and was not: a text-bearing rule line (a titled
	// border is exactly that shape) would newly qualify, and since the search takes the bottom-most
	// match, the divider could move DOWN past the real one - after which the upward headline walk stops
	// immediately on the true divider and returns a null headline where one used to be found. No
	// fixture covers that, so the tests would have called it equivalent.
	//
	// Pass 2 runs only when pass 1 found nothing, and admits a rule welded to text - the Windows shape.
	// Purely additive: it cannot change a frame pass 1 already answered. It is also UNPROVEN, since no
	// Windows limit-dialog frame has ever been captured; it is a reasoned extension, not a tested one.
	const findDivider = (accept: (line: string) => string | null): number => {
		for (let i = lines.length - 1; i >= 0; i--) {
			const after = accept(lines[i]);
			if (after === null) continue;
			const below = [after, ...lines.slice(i + 1)].join("\n");
			if (MENU_CURSOR_RE.test(below) && LIMIT_MENU_RE.test(below)) return i;
		}
		return -1;
	};
	let divider = findDivider((line) => (ANY_RULE_LINE_RE.test(line.trim()) ? "" : null));
	if (divider < 0) divider = findDivider((line) => afterRuleRun(line, ANY_RULE_RUN_RE));
	if (divider < 0) return limitWaiting(screen);
	// Walk up from the divider, stopping at the next border so a composer-present screen exposes only
	// the composer row. Blank rows do not spend budget; a wrapped headline needs the full allowance.
	const above: string[] = [];
	for (let i = divider - 1; i >= 0 && above.length < LIMIT_WINDOW_ROWS; i--) {
		const line = lines[i];
		if (TITLED_BORDER_RE.test(line.trim())) break;
		if (line.trim() === "") continue;
		above.push(line);
	}
	// Grow the join upward a row at a time and take the first size that matches. A single-row headline
	// therefore stays clean, while a wrapped one is rejoined far enough to recover a suffix that landed
	// on a continuation row, without swallowing the unrelated transcript above it. Rows join on a space
	// because the renderer wraps on word boundaries and drops the break itself.
	for (let take = 1; take <= above.length; take++) {
		const headline = above
			.slice(0, take)
			.reverse()
			.map((line) => line.trim())
			.join(" ");
		if (!LIMIT_HEADLINE_RE.test(headline)) continue;
		const dot = headline.indexOf("·");
		return { headline, detail: dot < 0 ? null : headline.slice(dot + 1).trim() || null };
	}
	// Blocked regardless: the dialog is up, the headline just is not on screen to say why.
	return { headline: null, detail: null };
}
