package com.atelier_nyaarium.switchboard

/** What opens a symbol detail, and the order of the items it draws. */

internal data class DetailOpen(val symbolId: String, val module: String, val name: String, val reached: Reached? = null)

internal sealed interface DetailItem {
	val key: String

	data object Header : DetailItem {
		override val key = "h"
	}

	data class Describe(val prose: String) : DetailItem {
		override val key = "ds"
	}

	data class ReachedCard(val reached: Reached) : DetailItem {
		override val key = "r"
	}

	data object Knowledge : DetailItem {
		override val key = "k"
	}

	data object Documentation : DetailItem {
		override val key = "d"
	}

	data object SourceTitle : DetailItem {
		override val key = "st"
	}

	data class SourceLine(val line: PaintedLine) : DetailItem {
		override val key = "src:${line.number}"
	}

	data class ShowAll(val lines: Int) : DetailItem {
		override val key = "all"
	}

	data object Facts : DetailItem {
		override val key = "f"
	}
}

internal fun detailItems(view: DetailView, reached: Reached?, whole: Boolean): List<DetailItem> {
	val knowledge = (view.knowledge as? WorkspaceAnswer.Read)?.value
	val source = (view.source as? WorkspaceAnswer.Read)?.value
	val documentation = knowledge?.documentation
	val describe = knowledge?.let(::describeProse)
	return buildList {
		add(DetailItem.Header)
		describe?.let { add(DetailItem.Describe(it)) }
		reached?.let { add(DetailItem.ReachedCard(it)) }
		add(DetailItem.Knowledge)
		if (!documentation.isNullOrBlank()) add(DetailItem.Documentation)
		// Always titled: the screen draws the read's own refusal under it.
		add(DetailItem.SourceTitle)
		if (source != null) {
			val painted = paintSource(source.text, source.spans, source.startLine)
			val window = sourceWindow(painted, reached?.line, whole)
			window.lines.forEach { add(DetailItem.SourceLine(it)) }
			if (window.hiddenAbove + window.hiddenBelow > 0) add(DetailItem.ShowAll(painted.size))
		}
		add(DetailItem.Facts)
	}
}

internal fun reachedIndex(items: List<DetailItem>): Int? =
	items.indexOfFirst { it is DetailItem.SourceLine && it.line.marked }.takeIf { it >= 0 }
