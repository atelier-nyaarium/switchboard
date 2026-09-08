package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookParameter

fun newRunbookId(): String = java.util.UUID.randomUUID().toString()

data class ParameterDraft(
	val label: String = "",
	val kind: String = "text",
	val options: List<String> = emptyList(),
	val default: String = "",
) {
	fun asKind(next: String): ParameterDraft =
		if (next == "choice") copy(kind = next, default = default.takeIf { it in options }.orEmpty())
		else copy(kind = next)
}

data class RunbookDraft(
	val id: String,
	val name: String = "",
	val body: String = "",
	val settings: Map<String, ParameterDraft> = emptyMap(),
	val revision: Long = 0L,
) {
	val declared: List<String>? get() = placeholdersOf(body)

	fun settingsFor(name: String): ParameterDraft = settings[name] ?: ParameterDraft(label = name)

	fun withSettings(name: String, edit: (ParameterDraft) -> ParameterDraft): RunbookDraft =
		copy(settings = settings + (name to edit(settingsFor(name))))

	fun refusal(): String? {
		if (name.isBlank()) return "Give it a name"
		if (body.isBlank()) return "Write the body"
		val names = declared ?: return "Finish the {{ in the body, or take it out"
		for (parameterName in names) {
			val setting = settingsFor(parameterName)
			if (setting.label.isBlank()) return "$parameterName: give it a label"
			if ((listOf(setting.default) + setting.options).any { it.contains("{{") }) {
				return "$parameterName: take the {{ out of its values"
			}
			if (setting.kind != "choice") continue
			if (setting.options.isEmpty()) return "$parameterName: add an option"
			if (setting.options.any { it.isBlank() }) return "$parameterName: an option is empty"
			if (setting.options.size != setting.options.toSet().size) return "$parameterName: remove the repeated option"
			if (setting.default.isNotBlank() && setting.default !in setting.options) {
				return "$parameterName: pick a default it offers, or none"
			}
		}
		return null
	}

	fun toRunbook(): Runbook? {
		if (refusal() != null) return null
		val names = declared ?: return null
		return Runbook(
			id = id,
			name = name.trim(),
			body = body,
			parameters = names.map { parameterName ->
				val setting = settingsFor(parameterName)
				RunbookParameter(
					name = parameterName,
					label = setting.label.trim(),
					kind = setting.kind,
					default = setting.default.ifBlank { null },
					options = if (setting.kind == "choice") setting.options else null,
				)
			},
			// The gateway names the stored revision; this only has to satisfy the schema.
			revision = maxOf(revision, 1L),
		)
	}

	companion object {
		fun of(runbook: Runbook) = RunbookDraft(
			id = runbook.id,
			name = runbook.name,
			body = runbook.body,
			settings = runbook.parameters.associate {
				it.name to ParameterDraft(
					label = it.label,
					kind = it.kind,
					options = it.options.orEmpty(),
					default = it.default.orEmpty(),
				)
			},
			revision = runbook.revision,
		)
	}
}
