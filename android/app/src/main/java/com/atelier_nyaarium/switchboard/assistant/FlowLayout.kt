package com.atelier_nyaarium.switchboard.assistant

internal data class FlowPoint(val x: Float, val y: Float)

internal data class FlowBox(val key: FlowKey, val center: FlowPoint, val width: Float, val height: Float) {
	val top: Float get() = center.y - height / 2
	val bottom: Float get() = center.y + height / 2

	fun holds(point: FlowPoint, slop: Float): Boolean =
		point.x in (center.x - width / 2 - slop)..(center.x + width / 2 + slop) &&
			point.y in (top - slop)..(bottom + slop)
}

/** Quadratic curve between edges. */
internal data class FlowCurve(val start: FlowPoint, val control: FlowPoint, val end: FlowPoint) {
	fun at(t: Float): FlowPoint {
		val u = 1 - t
		return FlowPoint(
			u * u * start.x + 2 * u * t * control.x + t * t * end.x,
			u * u * start.y + 2 * u * t * control.y + t * t * end.y,
		)
	}

	val mid: FlowPoint get() = at(0.5f)
}

internal data class FlowRowBand(val role: FlowRole, val layer: Int, val centerY: Float)

internal data class FlowLayout(
	val width: Float,
	val height: Float,
	val boxes: Map<FlowKey, FlowBox>,
	/** Curves follow graph lines. */
	val curves: List<FlowCurve>,
	val rows: List<FlowRowBand>,
) {
	fun hit(point: FlowPoint, slop: Float = 8f): FlowKey? = boxes.values.firstOrNull { it.holds(point, slop) }?.key
}

/** Dp sizes. */
internal object FlowSize {
	const val RING = 18f
	const val PILL_H = 30f
	const val PILL_PAD = 24f
	const val MARK = 14f
	const val ROW_GAP = 84f
	const val NODE_GAP = 16f
	const val PAD = 16f
	const val ROW_TITLE = 18f
	const val LABEL_H = 16f
	const val BEND = 18f
}

internal fun boxWidth(role: FlowRole, label: Float): Float = when (role) {
	FlowRole.START, FlowRole.ACTED -> maxOf(FlowSize.RING, label)
	FlowRole.AUTOMATION -> label + FlowSize.PILL_PAD
	FlowRole.FUNCTION -> label + FlowSize.PILL_PAD + FlowSize.MARK
}

internal fun boxHeight(role: FlowRole): Float = when (role) {
	FlowRole.START, FlowRole.ACTED -> FlowSize.RING
	FlowRole.AUTOMATION -> FlowSize.PILL_H + 10f
	FlowRole.FUNCTION -> FlowSize.PILL_H
}

/** Depth below deepest caller. */
internal fun functionDepths(graph: FlowGraph): Map<String, Int> {
	val callers = graph.lines.filter { it.to is FlowKey.Function && it.act != FlowAct.STARTS }
		.groupBy({ (it.to as FlowKey.Function).id }, { it.from })
	val depth = mutableMapOf<String, Int>()
	fun of(id: String, above: Set<String>): Int = depth[id] ?: run {
		val deepest = callers[id].orEmpty().mapNotNull { (it as? FlowKey.Function)?.id }
			.filter { it !in above }
			.maxOfOrNull { of(it, above + id) + 1 } ?: 0
		deepest.also { depth[id] = it }
	}
	graph.nodes.mapNotNull { (it.key as? FlowKey.Function)?.id }.forEach { of(it, emptySet()) }
	return depth
}

internal fun flowLayout(graph: FlowGraph, labelWidth: (FlowNode) -> Float, minWidth: Float): FlowLayout {
	val depths = functionDepths(graph)
	fun rowOf(node: FlowNode): Pair<FlowRole, Int> = roleOf(node.key).let { role ->
		role to if (role == FlowRole.FUNCTION) depths[(node.key as FlowKey.Function).id] ?: 0 else 0
	}
	val rowOrder = compareBy<Pair<FlowRole, Int>>({ it.first.ordinal }, { it.second })
	val rows = graph.nodes.groupBy(::rowOf).toSortedMap(rowOrder)
	val widths = graph.nodes.associate { it.key to boxWidth(roleOf(it.key), labelWidth(it)) }
	val bands = rows.keys.mapIndexed { index, (role, layer) ->
		FlowRowBand(role, layer, FlowSize.PAD + FlowSize.ROW_TITLE + FlowSize.LABEL_H + index * FlowSize.ROW_GAP + FlowSize.PILL_H / 2)
	}
	val bandOf = rows.keys.zip(bands).toMap()
	val x = mutableMapOf<FlowKey, Float>()
	/** Nearest nonoverlapping placement. */
	fun pack(nodes: List<Pair<FlowNode, Float>>) {
		var right = FlowSize.PAD - FlowSize.NODE_GAP
		for ((node, wish) in nodes.sortedBy { it.second }) {
			val w = widths.getValue(node.key)
			val at = maxOf(wish, right + FlowSize.NODE_GAP + w / 2)
			x[node.key] = at
			right = at + w / 2
		}
	}
	val placeOrder = rows.keys.sortedBy { if (it.first == FlowRole.AUTOMATION) 0 else 1 }
	for (row in placeOrder) {
		val nodes = rows.getValue(row)
		val near = { node: FlowNode, ends: (FlowLine) -> Pair<FlowKey, FlowKey> ->
			graph.lines.map(ends).filter { it.first == node.key }.mapNotNull { x[it.second] }.average().toFloat().takeUnless { it.isNaN() } ?: 0f
		}
		pack(
			when (row.first) {
				FlowRole.AUTOMATION -> nodes.mapIndexed { index, node -> node to index.toFloat() }
				FlowRole.START -> nodes.map { it to near(it) { line -> line.from to line.to } }
				FlowRole.FUNCTION, FlowRole.ACTED -> nodes.map { it to near(it) { line -> line.to to line.from } }
			},
		)
	}
	val width = maxOf(minWidth, (graph.nodes.maxOfOrNull { x.getValue(it.key) + widths.getValue(it.key) / 2 } ?: 0f) + FlowSize.PAD)
	val boxes = graph.nodes.associate { node ->
		val role = roleOf(node.key)
		node.key to FlowBox(node.key, FlowPoint(x.getValue(node.key), bandOf.getValue(rowOf(node)).centerY), widths.getValue(node.key), boxHeight(role))
	}
	val pairs = graph.lines.groupBy { it.from to it.to }
	val curves = graph.lines.map { line ->
		val from = boxes.getValue(line.from)
		val to = boxes.getValue(line.to)
		val twins = pairs.getValue(line.from to line.to)
		val bend = (twins.indexOf(line) - (twins.size - 1) / 2f) * FlowSize.BEND
		val start = FlowPoint(from.center.x, from.bottom)
		val end = FlowPoint(to.center.x, to.top)
		FlowCurve(start, FlowPoint((start.x + end.x) / 2 + bend, (start.y + end.y) / 2), end)
	}
	val height = (bands.lastOrNull()?.centerY ?: 0f) + FlowSize.PILL_H / 2 + FlowSize.LABEL_H + FlowSize.PAD
	return FlowLayout(width, height, boxes, curves, bands)
}
