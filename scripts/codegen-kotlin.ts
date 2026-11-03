import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { OWNER_OP_KIND_LIST } from "../src/federation-server/ownerOpRegistry.js";
import {
	AdmissionSchema,
	RevocationSchema,
	SignedAdmissionSchema,
	SignedRevocationSchema,
} from "../src/shared/admission.js";
import {
	CONSOLE_ANSWER_WAIT_MS,
	CONSOLE_PROTOCOL_VERSION,
	CREATE_SESSION_BOUND_MS,
} from "../src/shared/console-protocol.js";
import {
	ConsoleApprovalOpSchema,
	ConsoleApprovalResultSchema,
	EnrollHandshakeOpSchema,
	EnrollHandshakeResultSchema,
	EnrollOpSchema,
	EnrollResultSchema,
	FirstRootSchema,
	PendingTenantSchema,
	RosterRequestSchema,
	RosterResultSchema,
	SignedFirstRootSchema,
	TransportRequestSchema,
	TransportResultSchema,
	TrustHandshakeOpSchema,
	TrustHandshakeResultSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
} from "../src/shared/federation-lifecycle.js";
import { SignedXDomainUntrustSchema } from "../src/shared/federation-protocol.js";
import {
	BLOB_CHUNK_BYTES,
	FEDERATION_PROTOCOL_FLOOR,
	FEDERATION_PROTOCOL_VERSION,
	MAX_BLOB_BYTES,
} from "../src/shared/router-protocol.js";
import {
	BlobBeginAnswerSchema,
	BlobBeginValueSchema,
	BlobChunkAnswerSchema,
	BlobChunkValueSchema,
	BlobFetchAnswerSchema,
	BlobFetchValueSchema,
	BlobLeaseSchema,
	BlobUploadStatusAnswerSchema,
	BlobUploadStatusValueSchema,
	BOARD_ATTACHMENTS_MAX,
	BOARD_AUTO_DOWNLOAD_MAX_BYTES,
	ChannelFileSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleForgetResultSchema,
	ConsoleListDirsResultSchema,
	ConsoleOpSchema,
	ConsolePeekResultSchema,
	ConsolePollResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleRenameSessionResultSchema,
	ConsoleReportReadResultSchema,
	ConsoleRespondResultSchema,
	ConsoleSendResultSchema,
	ConsoleTmuxSendResultSchema,
	ContentEnvelopeSchema,
	CrossDomainCancelResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainListenResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainPresenceEntrySchema,
	CrossDomainRequestResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainShareTargetSchema,
	CrossDomainUnlinkResultSchema,
	CrossDomainUnshareResultSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	GatewayTransportSchema,
	GatewayValueOpSchema,
	InboxRowSchema,
	KeyEnvelopeSchema,
	KeyGrantOpSchema,
	KeyGrantSchema,
	KeyReceiptEntrySchema,
	KeyReceiptOpSchema,
	KeyReceiptSchema,
	KeyReceiptsReadOpSchema,
	KeyReceiptsReadResultSchema,
	KeyRequestOpSchema,
	KeyRequestSchema,
	MailboxEntrySchema,
	OpKeySchema,
	OpResultEnvelopeSchema,
	OwnerOpSchema,
	PlaneLineageSchema,
	PlaneReadSchema,
	PlanesReadResultSchema,
	PlanesReadValueSchema,
	ProvisioningSchema,
	RowEnvelopeSchema,
	RowOriginSchema,
	TeamInfoSchema,
} from "../src/shared/schemas.js";
import { AssistantWatcherSchema, ConsoleAssistantStateResultSchema } from "../src/shared/schemasAssistant.js";
import {
	AssistantHomeCarriedSchema,
	AssistantHomeCarriedWatcherSchema,
	AssistantHomePutResultSchema,
	AssistantHomePutValueSchema,
	AssistantHomeReadResultSchema,
	AssistantHomeReadValueSchema,
	AssistantHomeRecordSchema,
	AssistantHomeRefusalSchema,
	AssistantHomeReportSchema,
	AssistantHomeSealedSchema,
} from "../src/shared/schemasAssistantHome.js";
import { ACTION_OUTCOMES } from "../src/shared/schemasAssistantRecord.js";
import {
	AssistantFieldOptionSchema,
	AssistantFieldSpecSchema,
	AssistantFieldValueSchema,
	AssistantRuleConditionSchema,
	AssistantRuleInvalidSchema,
	AssistantRuleOtherwiseSchema,
	AssistantRuleSchema,
	AssistantUnexpectedValuesSchema,
	AssistantWatcherRulesSchema,
	ConsoleAssistantPreviewResultSchema,
	ConsoleAssistantRulesResultSchema,
} from "../src/shared/schemasAssistantRules.js";
import {
	AssistantSendFileSchema,
	AssistantSendIntentSchema,
	AssistantSendRequestSchema,
	AssistantSendRetractSchema,
	ConsoleAssistantSendAnswerResultSchema,
} from "../src/shared/schemasAssistantSend.js";
import {
	BoardActorSchema,
	BoardObservationRowSchema,
	BoardOpSchema,
	BoardReadResultSchema,
	BoardStoredEntrySchema,
	BoardWriteResultSchema,
	BoardWriteSchema,
} from "../src/shared/schemasBoardState.js";
import {
	ConsoleAckFrameSchema,
	ConsoleHelloFrameSchema,
	ConsoleInboxRowsFrameSchema,
	ConsolePingFrameSchema,
	ConsolePlaneFrameSchema,
	ConsolePongFrameSchema,
	ConsoleRefusedFrameSchema,
	ConsoleSocketInboundSchema,
	ConsoleSocketOutboundSchema,
	ConsoleWelcomeFrameSchema,
} from "../src/shared/schemasConsoleSocket.js";
import {
	DEVICE_ACTIONS,
	DEVICE_CLOUD_STATES,
	DEVICE_CONSOLE_RESULTS,
	DEVICE_DRIVERS,
	DEVICE_EFFECTS,
	DEVICE_KINDS,
	DEVICE_MAX_RULES,
	DEVICE_REFUSAL_CODES,
	DEVICE_STATES,
	DEVICE_VERBS,
	DeviceAddressSchema,
	DeviceCandidateSchema,
	DeviceCloudStateSchema,
	DeviceDriverSchema,
	DeviceEffectSchema,
	DeviceIdSchema,
	DeviceKindSchema,
	DeviceLandedSchema,
	DeviceLiveStateSchema,
	DeviceNameSchema,
	DeviceRecordSchema,
	DeviceRefusalCodeSchema,
	DeviceRefusalSchema,
	DeviceRevisionSchema,
	DeviceScheduleActionSchema,
	DeviceScheduleRuleSchema,
	DeviceScheduleSchema,
	DeviceSettingPutSchema,
	DeviceSettingsSchema,
	DeviceStateSchema,
	DeviceVerbSchema,
	KASA_SETTING_KEYS,
	KasaClockSchema,
	KasaDeviceSettingsSchema,
	KasaSettingPutSchema,
} from "../src/shared/schemasDevices.js";
import { RowRecipientSchema, RowStampSchema } from "../src/shared/schemasInbox.js";
import {
	ACT_TIERS,
	DEVICE_CAPABILITIES,
	INTEGRATION_DISCOVERIES,
	INTEGRATION_GROUPS,
	INTEGRATION_KEYS,
	INTEGRATION_NEED_KINDS,
	INTEGRATION_YIELDS,
	INTEGRATIONS,
} from "../src/shared/schemasIntegrations.js";
import {
	AssistantActRequestSchema,
	CapabilityGuardSchema,
	PHONE_CAPABILITIES,
	PHONE_CAPABILITY_KEYS,
	PHONE_CAPABILITY_WAIT_MS,
	PhoneCapabilityAnswerSchema,
	PhoneCapabilityRowSchema,
	PhoneContactSchema,
	PhonePermissionSchema,
	PhoneStatusKeySchema,
	UNAVAILABLE_REASONS,
	UnavailableReasonSchema,
} from "../src/shared/schemasPhoneCapabilities.js";
import {
	HoldClaimResultSchema,
	HoldClaimValueSchema,
	PHONE_HOLD_PLANE,
	PHONE_HOLD_WINDOW_MS,
	PhoneHoldPlaneSchema,
	PhoneHoldReadValueSchema,
	PhoneHoldRecordSchema,
} from "../src/shared/schemasPhoneHold.js";
import {
	AuthorizationPolicySchema,
	ConsolePolicyDeleteResultSchema,
	ConsolePolicyListResultSchema,
	ConsolePolicyPutResultSchema,
	PolicyBindingSchema,
} from "../src/shared/schemasPolicy.js";
import {
	FriendPresenceProjectionSchema,
	OwnerPresenceProjectionSchema,
	RosterEntrySchema,
} from "../src/shared/schemasRouterPresence.js";
import {
	ConsoleRoutineDeleteResultSchema,
	ConsoleRoutineListResultSchema,
	ConsoleRoutineNextResultSchema,
	ConsoleRoutineOccurrenceResultSchema,
	ConsoleRoutinePutResultSchema,
	ConsoleRoutineRunResultSchema,
	RoutineMissSchema,
	RoutineSchema,
	RoutineStateSchema,
	RoutineTargetSchema,
} from "../src/shared/schemasRoutine.js";
import {
	ConsoleRunbookDeleteResultSchema,
	ConsoleRunbookFireResultSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPreviewResultSchema,
	ConsoleRunbookPutResultSchema,
	RunbookFireTargetSchema,
	RunbookParameterSchema,
	RunbookSchema,
} from "../src/shared/schemasRunbook.js";
import {
	ScheduleCancelValueSchema,
	ScheduledRecordSchema,
	ScheduledResultRowSchema,
	ScheduleSendValueSchema,
} from "../src/shared/schemasScheduled.js";
import {
	CrossDomainShareValueSchema,
	CrossDomainUnlinkValueSchema,
	CrossDomainUnshareValueSchema,
} from "../src/shared/schemasShare.js";
import {
	CapabilitiesReportSchema,
	CapabilitySnapshotWireSchema,
	ReadAnchorsResultSchema,
	ReportReadSchema,
} from "../src/shared/schemasTier1.js";
import {
	ConsoleVaultAnswerResultSchema,
	ConsoleVaultGrantsResultSchema,
	ConsoleVaultRevokeResultSchema,
	VaultDeleteValueSchema,
	VaultGrantSchema,
	VaultHolderSchema,
	VaultListResultSchema,
	VaultListValueSchema,
	VaultPutSchema,
	VaultPutValueSchema,
	VaultRequestSchema,
	VaultRetractSchema,
	VaultStoredEntrySchema,
	VaultWriteResultSchema,
} from "../src/shared/schemasVault.js";
import {
	WireFixtureEntrySchema,
	WireFixtureSchema,
	WireFrameSchema,
	WireManifestSchema,
	WirePhoneDecodeSchema,
	WireRequestSchema,
	WireSealedSchema,
} from "../src/shared/schemasWireFixture.js";
import {
	FacetAnswerSchema,
	FacetCommentSchema,
	FacetSymbolSchema,
	FacetTargetSchema,
	FacetTypeSchema,
	FacetUnboundTypeSchema,
	FacetUseSchema,
	FileDestinationSchema,
	FileHistoryAnswerSchema,
	FileMutationAnswerSchema,
	FileMutationSchema,
	FileStateAnswerSchema,
	HistoryCommitSchema,
	KnowledgeAnswerSchema,
	KnowledgeCountsSchema,
	MAX_HISTORY_COMMITS,
	OutlineAnswerSchema,
	OutlineSymbolSchema,
	PaintTextAnswerSchema,
	ReadAnswerSchema,
	SaveIssueSchema,
	SaveSpanAnswerSchema,
	SymbolFacetAnswerSchema,
	SymbolFacetSchema,
	SymbolSourceAnswerSchema,
	TooLargeAnswerSchema,
	TreeAnswerSchema,
	TreeEntrySchema,
} from "../src/shared/schemasWorkspace.js";
import {
	ADDRESS_SEP,
	CONV_TAG,
	DEFAULT_SESSION,
	MAX_CONV_ID_LEN,
	MAX_SLUG_LEN,
	NOTICE_TAG,
	SLUG_RE,
} from "../src/shared/session-id.js";
import { SttsProvidersSchema } from "../src/shared/stts-providers.js";
import {
	ASSISTANT_ROLE,
	ASSISTANT_RULE_CONDITIONS_MAX,
	ASSISTANT_RULE_VALUE_MAX,
	ASSISTANT_RULES_MAX,
	BEARER_PREFIX,
	BOARD_OUTCOME_APPLIED,
	CONSOLE_REASON_CURSOR_STALE,
	CONSOLE_TOKEN_HEADER,
	CONTENT_NONCE_BYTES,
	GATEWAY_ERROR_INBOX_UNAVAILABLE,
	GATEWAY_ERROR_NOT_ADMITTED,
	GATEWAY_ERROR_NOT_REGISTERED,
	GATEWAY_ERROR_STALE_INCARNATION,
	GATEWAY_REASON_NO_WAITER,
	OP_OUTCOME_ACCEPTED,
	ROUTER_PATHS,
	ROUTINE_FORGET_DAYS_DEFAULT,
	ROUTINE_FORGET_DAYS_MAX,
	ROUTINE_FORGET_DAYS_MIN,
	SIGNING_TAGS,
	WIRE_NONCE_BYTES,
} from "../src/shared/wire-vocabulary.js";

const OUT_PATH =
	process.env.KOTLIN_PROTOCOL_OUT ??
	join(import.meta.dir, "../android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/Protocol.kt");
const PHONE_CAPABILITY_REGISTRY_OUT_PATH =
	process.env.KOTLIN_PHONE_CAPABILITY_REGISTRY_OUT ??
	join(
		import.meta.dir,
		"../android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/PhoneCapabilityRegistry.kt",
	);
const INTEGRATION_REGISTRY_OUT_PATH =
	process.env.KOTLIN_INTEGRATION_REGISTRY_OUT ??
	join(import.meta.dir, "../android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/IntegrationRegistry.kt");

const ROOTS: z.ZodType[] = [
	RowRecipientSchema,
	RowStampSchema,
	PhoneHoldRecordSchema,
	PhoneHoldPlaneSchema,
	HoldClaimValueSchema,
	HoldClaimResultSchema,
	PhoneHoldReadValueSchema,
	PhonePermissionSchema,
	UnavailableReasonSchema,
	CapabilityGuardSchema,
	PhoneStatusKeySchema,
	PhoneContactSchema,
	...PHONE_CAPABILITY_KEYS.flatMap((key) => [PHONE_CAPABILITIES[key].request, PHONE_CAPABILITIES[key].answer]),
	PhoneCapabilityRowSchema,
	PhoneCapabilityAnswerSchema,
	AssistantActRequestSchema,
	ChannelFileSchema,
	TeamInfoSchema,
	MailboxEntrySchema,
	CrossDomainShareTargetSchema,
	ConsoleOpSchema,
	ConsolePollResultSchema,
	FirstRootSchema,
	SignedFirstRootSchema,
	CrossDomainPresenceEntrySchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
	ConsoleHelloFrameSchema,
	ConsoleAckFrameSchema,
	ConsolePingFrameSchema,
	ConsoleSocketInboundSchema,
	ConsoleWelcomeFrameSchema,
	ConsoleInboxRowsFrameSchema,
	ConsolePlaneFrameSchema,
	ConsoleRefusedFrameSchema,
	ConsolePongFrameSchema,
	ConsoleSocketOutboundSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleForgetResultSchema,
	ConsoleReportReadResultSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleRenameSessionResultSchema,
	ConsoleListDirsResultSchema,
	BlobLeaseSchema,
	BlobBeginValueSchema,
	BlobChunkValueSchema,
	BlobUploadStatusValueSchema,
	BlobFetchValueSchema,
	BlobBeginAnswerSchema,
	BlobChunkAnswerSchema,
	BlobUploadStatusAnswerSchema,
	BlobFetchAnswerSchema,
	CrossDomainListenResultSchema,
	CrossDomainRequestResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainCancelResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainUnshareResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainUnlinkResultSchema,
	PolicyBindingSchema,
	AuthorizationPolicySchema,
	ConsolePolicyListResultSchema,
	ConsolePolicyPutResultSchema,
	ConsolePolicyDeleteResultSchema,
	DeviceKindSchema,
	DeviceDriverSchema,
	DeviceCloudStateSchema,
	DeviceIdSchema,
	DeviceNameSchema,
	DeviceAddressSchema,
	DeviceRevisionSchema,
	DeviceRecordSchema,
	DeviceStateSchema,
	DeviceScheduleActionSchema,
	DeviceVerbSchema,
	DeviceLiveStateSchema,
	DeviceScheduleRuleSchema,
	DeviceScheduleSchema,
	KasaClockSchema,
	KasaDeviceSettingsSchema,
	DeviceSettingsSchema,
	KasaSettingPutSchema,
	DeviceSettingPutSchema,
	DeviceCandidateSchema,
	DeviceRefusalCodeSchema,
	DeviceEffectSchema,
	DeviceLandedSchema,
	DeviceRefusalSchema,
	...Object.values(DEVICE_CONSOLE_RESULTS),
	AssistantWatcherSchema,
	ConsoleAssistantStateResultSchema,
	AssistantHomeCarriedWatcherSchema,
	AssistantHomeCarriedSchema,
	AssistantHomeSealedSchema,
	AssistantHomeRecordSchema,
	AssistantHomeReportSchema,
	AssistantHomeReadValueSchema,
	AssistantHomeReadResultSchema,
	AssistantHomePutValueSchema,
	AssistantHomeRefusalSchema,
	AssistantHomePutResultSchema,
	AssistantRuleConditionSchema,
	AssistantRuleSchema,
	AssistantRuleOtherwiseSchema,
	AssistantWatcherRulesSchema,
	ConsoleAssistantRulesResultSchema,
	ConsoleAssistantPreviewResultSchema,
	AssistantFieldOptionSchema,
	AssistantFieldSpecSchema,
	AssistantRuleInvalidSchema,
	AssistantFieldValueSchema,
	AssistantUnexpectedValuesSchema,
	AssistantSendFileSchema,
	AssistantSendIntentSchema,
	AssistantSendRequestSchema,
	AssistantSendRetractSchema,
	ConsoleAssistantSendAnswerResultSchema,
	ProvisioningSchema,
	SttsProvidersSchema,
	AdmissionSchema,
	SignedAdmissionSchema,
	RevocationSchema,
	SignedRevocationSchema,
	EnrollOpSchema,
	EnrollResultSchema,
	EnrollHandshakeOpSchema,
	EnrollHandshakeResultSchema,
	ConsoleApprovalOpSchema,
	ConsoleApprovalResultSchema,
	PendingTenantSchema,
	GatewayTransportSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	ContentEnvelopeSchema,
	KeyEnvelopeSchema,
	KeyRequestSchema,
	KeyGrantSchema,
	KeyReceiptSchema,
	KeyRequestOpSchema,
	KeyGrantOpSchema,
	KeyReceiptOpSchema,
	KeyReceiptsReadOpSchema,
	KeyReceiptEntrySchema,
	KeyReceiptsReadResultSchema,
	SignedXDomainUntrustSchema,
	RosterRequestSchema,
	RosterResultSchema,
	TrustHandshakeOpSchema,
	TrustHandshakeResultSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
	TransportRequestSchema,
	TransportResultSchema,
	OwnerOpSchema,
	GatewayValueOpSchema,
	PlaneLineageSchema,
	PlaneReadSchema,
	PlanesReadResultSchema,
	PlanesReadValueSchema,
	InboxRowSchema,
	RowEnvelopeSchema,
	RowOriginSchema,
	OpKeySchema,
	OpResultEnvelopeSchema,
	OwnerPresenceProjectionSchema,
	FriendPresenceProjectionSchema,
	RosterEntrySchema,
	CrossDomainShareValueSchema,
	CrossDomainUnshareValueSchema,
	CrossDomainUnlinkValueSchema,
	BoardStoredEntrySchema,
	BoardActorSchema,
	BoardOpSchema,
	BoardWriteSchema,
	BoardWriteResultSchema,
	BoardReadResultSchema,
	BoardObservationRowSchema,
	VaultStoredEntrySchema,
	VaultPutSchema,
	VaultWriteResultSchema,
	VaultListResultSchema,
	VaultListValueSchema,
	VaultPutValueSchema,
	VaultDeleteValueSchema,
	VaultRequestSchema,
	VaultRetractSchema,
	VaultGrantSchema,
	ConsoleVaultAnswerResultSchema,
	ConsoleVaultGrantsResultSchema,
	ConsoleVaultRevokeResultSchema,
	RunbookParameterSchema,
	RunbookSchema,
	RunbookFireTargetSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPutResultSchema,
	ConsoleRunbookDeleteResultSchema,
	ConsoleRunbookPreviewResultSchema,
	ConsoleRunbookFireResultSchema,
	RoutineTargetSchema,
	RoutineSchema,
	RoutineMissSchema,
	RoutineStateSchema,
	ConsoleRoutineListResultSchema,
	ConsoleRoutinePutResultSchema,
	ConsoleRoutineDeleteResultSchema,
	ConsoleRoutineNextResultSchema,
	ConsoleRoutineOccurrenceResultSchema,
	ConsoleRoutineRunResultSchema,
	ScheduledRecordSchema,
	ScheduleSendValueSchema,
	ScheduleCancelValueSchema,
	ScheduledResultRowSchema,
	CapabilitiesReportSchema,
	CapabilitySnapshotWireSchema,
	ReportReadSchema,
	ReadAnchorsResultSchema,
	WireFrameSchema,
	WireRequestSchema,
	WirePhoneDecodeSchema,
	WireSealedSchema,
	VaultHolderSchema,
	WireFixtureSchema,
	WireFixtureEntrySchema,
	WireManifestSchema,
	TreeEntrySchema,
	TreeAnswerSchema,
	ReadAnswerSchema,
	OutlineSymbolSchema,
	OutlineAnswerSchema,
	SymbolSourceAnswerSchema,
	KnowledgeAnswerSchema,
	SaveIssueSchema,
	SaveSpanAnswerSchema,
	FileDestinationSchema,
	FileMutationSchema,
	FileMutationAnswerSchema,
	FileStateAnswerSchema,
	KnowledgeCountsSchema,
	SymbolFacetSchema,
	FacetSymbolSchema,
	FacetUseSchema,
	FacetTargetSchema,
	FacetTypeSchema,
	FacetUnboundTypeSchema,
	FacetCommentSchema,
	HistoryCommitSchema,
	FacetAnswerSchema,
	SymbolFacetAnswerSchema,
	FileHistoryAnswerSchema,
	TooLargeAnswerSchema,
	PaintTextAnswerSchema,
];

const SEALED_ROOTS = new Set([
	"ConsoleOp",
	"EnrollOp",
	"EnrollHandshakeOp",
	"ConsoleApprovalOp",
	"TrustHandshakeOp",
	"CrossDomainShareTarget",
	"RunbookFireTarget",
	"BoardOp",
	"BoardActor",
	"VaultGrant",
	"VaultHolder",
	"VaultRequest",
	"DeviceSettings",
	"DeviceSettingPut",
	"KasaSettingPut",
	...Object.values(DEVICE_CONSOLE_RESULTS).map(idOf),
	"WireFixture",
	"WorkspaceFileMutation",
	"WorkspaceFileDestination",
	"WorkspaceFacet",
	"WorkspaceFacetAnswer",
	"AssistantFieldSpec",
	"PhoneCapabilityAnswer",
]);

type Json = Record<string, unknown>;

function zodToCleanJsonSchema(schema: z.ZodType): Json {
	// Strip format only; other schema metadata is preserved.
	const json = z.toJSONSchema(schema, { io: "input" }) as Json;
	delete json.$schema;
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		const record = node as Json;
		if (typeof record.format === "string") delete record.format;
		for (const key in record) walk(record[key]);
	};
	walk(json);
	return json;
}

function discriminatorOf(schema: z.ZodType): string {
	const def = (schema as unknown as { _zod: { def: { discriminator?: string } } })._zod.def;
	if (!def.discriminator) throw new Error("schema has no discriminator");
	return def.discriminator;
}

function idOf(schema: z.ZodType): string {
	const id = z.globalRegistry.get(schema)?.id;
	if (!id) throw new Error("root schema missing .meta({ id })");
	return id;
}

const KOTLIN_KEYWORDS = new Set([
	"as",
	"break",
	"class",
	"continue",
	"do",
	"else",
	"false",
	"for",
	"fun",
	"if",
	"in",
	"interface",
	"is",
	"null",
	"object",
	"package",
	"return",
	"super",
	"this",
	"throw",
	"true",
	"try",
	"typealias",
	"typeof",
	"val",
	"var",
	"when",
	"while",
]);

function isKotlinIdentifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !KOTLIN_KEYWORDS.has(value);
}

function kotlinIdentifier(value: string): string {
	return KOTLIN_KEYWORDS.has(value) ? `\`${value}\`` : value;
}

function kotlinConstName(name: string): string {
	return name.replace(/[a-z][A-Z]/g, (match) => `${match[0]}_${match[1]}`).toUpperCase();
}

type PhoneCapabilityCodegenSpec = {
	key: keyof typeof PHONE_CAPABILITIES;
	methodName: string;
	constantName: string;
	requestId: string;
	answerId: string;
};

function phoneCapabilityCodegenSpecs(): PhoneCapabilityCodegenSpec[] {
	const specs: PhoneCapabilityCodegenSpec[] = [];
	const methodOwners = new Map<string, string>();
	const constantOwners = new Map<string, string>();
	const schemaIdOwners = new Map<string, { key: string; side: string }>();

	for (const key of PHONE_CAPABILITY_KEYS) {
		const capability = PHONE_CAPABILITIES[key];
		const pieces = key.split(/[_-]/);
		if (!/^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$/.test(key)) {
			throw new Error(`${key}: capability key cannot form a Kotlin handler name`);
		}
		const methodName =
			pieces[0]!.charAt(0).toLowerCase() +
			pieces[0]!.slice(1) +
			pieces
				.slice(1)
				.map((piece) => piece.charAt(0).toUpperCase() + piece.slice(1))
				.join("");
		if (!isKotlinIdentifier(methodName)) {
			throw new Error(`${key}: handler name "${methodName}" is not a Kotlin identifier`);
		}
		const methodOwner = methodOwners.get(methodName);
		if (methodOwner) throw new Error(`${key}: handler name "${methodName}" collides with key "${methodOwner}"`);
		methodOwners.set(methodName, key);

		const constantName = kotlinConstName(key);
		if (!isKotlinIdentifier(constantName)) {
			throw new Error(`${key}: key constant "${constantName}" is not a Kotlin identifier`);
		}
		const constantOwner = constantOwners.get(constantName);
		if (constantOwner)
			throw new Error(`${key}: key constant "${constantName}" collides with key "${constantOwner}"`);
		constantOwners.set(constantName, key);

		const schemaIds: { side: string; schema: z.ZodType; id: string | undefined }[] = [
			{ side: "request", schema: capability.request, id: z.globalRegistry.get(capability.request)?.id },
			{ side: "answer", schema: capability.answer, id: z.globalRegistry.get(capability.answer)?.id },
		];
		for (const { side, schema, id } of schemaIds) {
			if (!id) throw new Error(`${key}: ${side} schema is missing .meta({ id })`);
			if (!isKotlinIdentifier(id)) {
				throw new Error(`${key}: ${side} schema id "${id}" is not a Kotlin identifier`);
			}
			const schemaOwner = schemaIdOwners.get(id);
			if (schemaOwner) {
				throw new Error(
					`${key}: ${side} schema id "${id}" collides with ${schemaOwner.key} ${schemaOwner.side}`,
				);
			}
			const rootOwner = ROOTS.find((root) => root !== schema && z.globalRegistry.get(root)?.id === id);
			if (rootOwner) {
				const capabilityOwner = PHONE_CAPABILITY_KEYS.find((ownerKey) => {
					const owner = PHONE_CAPABILITIES[ownerKey];
					return (
						(owner.request === rootOwner && ownerKey !== key) ||
						(owner.answer === rootOwner && ownerKey !== key)
					);
				});
				throw new Error(
					`${key}: ${side} schema id "${id}" collides with ${capabilityOwner ?? "another schema"}`,
				);
			}
			schemaIdOwners.set(id, { key, side });
		}

		specs.push({
			key,
			methodName,
			constantName,
			requestId: schemaIds[0]!.id!,
			answerId: schemaIds[1]!.id!,
		});
	}
	return specs;
}

const PHONE_CAPABILITY_SPECS = phoneCapabilityCodegenSpecs();

const INDENT = "\t";

function pascal(value: string): string {
	return value
		.split(/[_\-\s]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/** A nullable field arrives as a type array holding null, or as a two-member union with a null member. */
function nullableInner(node: Json): Json | null {
	const types = node.type;
	if (Array.isArray(types) && types.length === 2 && types.includes("null")) {
		return { ...node, type: types.find((type) => type !== "null") };
	}
	const members = (node.anyOf ?? node.oneOf) as Json[] | undefined;
	if (members?.length !== 2) return null;
	const nullIndex = members.findIndex((m) => (m as Json).type === "null");
	if (nullIndex === -1) return null;
	return members[1 - nullIndex] as Json;
}

/** Every type a field is typed as, so nothing can be referenced and never declared. */
const referenced = new Set<string>();

function kotlinType(node: Json, defs: Map<string, Json>): string {
	const ref = node.$ref as string | undefined;
	if (ref) {
		const name = ref.replace("#/$defs/", "");
		const target = defs.get(name);
		if (!target) throw new Error(`unresolved $ref ${ref}`);
		if (!target.properties && !target.oneOf && !target.anyOf) return kotlinType(target, defs);
		referenced.add(name);
		return name;
	}
	const inner = nullableInner(node);
	if (inner) return kotlinType(inner, defs);
	if (node.anyOf || node.oneOf) return "JsonElement";
	const type = node.type as string | undefined;
	switch (type) {
		case "string":
			return "String";
		case "integer":
			return "Long";
		case "number":
			return "Double";
		case "boolean":
			return "Boolean";
		case "array": {
			const items = node.items as Json | undefined;
			return `List<${items ? kotlinType(items, defs) : "JsonElement"}>`;
		}
		case "object":
			if (node.properties)
				throw new Error("inline object without $defs id - add .meta({ id }) to the sub-schema");
			return "JsonObject";
		default:
			return "JsonElement";
	}
}

function escapeKdoc(text: string): string {
	return text.replace(/\*\//g, "*&#47;").trim();
}

function kotlinString(value: string): string {
	return JSON.stringify(value).replace(/\$/g, "\\$");
}

function emitParams(node: Json, defs: Map<string, Json>, omit: Set<string>): string[] {
	const props = (node.properties ?? {}) as Record<string, Json>;
	const required = new Set((node.required as string[] | undefined) ?? []);
	const lines: string[] = [];
	for (const [name, prop] of Object.entries(props)) {
		if (omit.has(name)) continue;
		const baseType = kotlinType(prop, defs);
		const nullable = nullableInner(prop) !== null;
		const optional = !required.has(name) || nullable;
		const constValue = prop.const;
		const description = prop.description as string | undefined;
		if (description) lines.push(`${INDENT}/** ${escapeKdoc(description)} */`);
		if (typeof constValue === "string") {
			if (required.has(name)) lines.push(`${INDENT}@EncodeDefault`);
			lines.push(`${INDENT}val ${kotlinIdentifier(name)}: ${baseType} = ${kotlinString(constValue)},`);
		} else if (constValue !== undefined) {
			if (typeof constValue !== "number") throw new Error(`unsupported const for ${name}`);
			const isInteger = Number.isInteger(constValue);
			const type = isInteger ? "Long" : baseType;
			const literal = isInteger ? `${constValue}L` : `${constValue}`;
			lines.push(
				required.has(name)
					? `${INDENT}val ${kotlinIdentifier(name)}: ${type},`
					: `${INDENT}val ${kotlinIdentifier(name)}: ${type} = ${literal},`,
			);
		} else if (optional) {
			lines.push(`${INDENT}val ${kotlinIdentifier(name)}: ${baseType}? = null,`);
		} else {
			lines.push(`${INDENT}val ${kotlinIdentifier(name)}: ${baseType},`);
		}
	}
	return lines;
}

function emitDataClass(name: string, node: Json, defs: Map<string, Json>): string {
	const params = emitParams(node, defs, new Set());
	// Data classes require parameters.
	if (params.length === 0) return [`@Serializable`, `class ${name}`].join("\n");
	return [`@Serializable`, `data class ${name}(`, ...params, `)`].join("\n");
}

const PROTO_PACKAGE = "com.atelier_nyaarium.switchboard.proto";

function qualifyShadowed(line: string, memberName: string): string {
	return line.replace(new RegExp(`\\b${memberName}\\b`, "g"), `${PROTO_PACKAGE}.${memberName}`);
}

function emitSealedClass(name: string, node: Json, discriminator: string, defs: Map<string, Json>): string {
	// SerialName carries the wire discriminator.
	const members = (node.oneOf ?? node.anyOf) as Json[];
	if (!members) throw new Error(`sealed root ${name} has no oneOf`);
	const out: string[] = [
		`@Serializable`,
		`@OptIn(ExperimentalSerializationApi::class)`,
		`@JsonClassDiscriminator(${kotlinString(discriminator)})`,
		`sealed class ${name} {`,
	];
	for (const member of members) {
		const props = (member.properties ?? {}) as Record<string, Json>;
		const kindValue = props[discriminator]?.const as string | undefined;
		if (!kindValue) throw new Error(`sealed member of ${name} lacks const ${discriminator}`);
		const memberName = pascal(kindValue);
		const params = emitParams(member, defs, new Set([discriminator])).map((line) =>
			qualifyShadowed(line, memberName),
		);
		out.push(`${INDENT}@Serializable`);
		out.push(`${INDENT}@SerialName(${kotlinString(kindValue)})`);
		if (params.length === 0) {
			out.push(`${INDENT}data object ${memberName} : ${name}()`);
		} else {
			out.push(`${INDENT}data class ${memberName}(`);
			out.push(...params.map((line) => `${INDENT}${line}`));
			out.push(`${INDENT}) : ${name}()`);
		}
		out.push("");
	}
	while (out[out.length - 1] === "") out.pop();
	out.push(`}`);
	return out.join("\n");
}

const defs = new Map<string, Json>();
const rootIds: string[] = [];

for (const schema of ROOTS) {
	const id = idOf(schema);
	const json = zodToCleanJsonSchema(schema);
	const nested = (json.$defs ?? {}) as Record<string, Json>;
	delete json.$defs;
	// A registered root converts to a $ref into its own $defs; the body there is the root's shape.
	const body = json.$ref === `#/$defs/${id}` ? (nested[id] as Json) : json;
	const guardedSet = (name: string, body: Json) => {
		const existing = defs.get(name);
		if (existing && JSON.stringify(existing) !== JSON.stringify(body)) {
			throw new Error(`conversion-root versus inline-object conflict: "${name}" maps to two different shapes`);
		}
		defs.set(name, body);
	};
	guardedSet(id, body);
	for (const [name, body] of Object.entries(nested)) {
		if (name === id) continue;
		guardedSet(name, body);
	}
	rootIds.push(id);
}

for (const spec of PHONE_CAPABILITY_SPECS) {
	for (const [side, id] of [
		["request", spec.requestId],
		["answer", spec.answerId],
	] as const) {
		const node = defs.get(id);
		if (!node?.properties) {
			throw new Error(`${spec.key}: ${side} schema id "${id}" does not resolve to a Kotlin class`);
		}
	}
}

const order = [...new Set([...rootIds, ...defs.keys()])];

function literalValues(schema: z.ZodType, field: string): string[] {
	const definition = (schema as unknown as { _def: { options?: unknown[]; shape?: Record<string, ZodInternal> } })
		._def;
	const options = definition.options ?? [];
	return options.flatMap((option) => {
		const shape = (option as { _def?: { shape?: Record<string, ZodInternal> } })._def?.shape;
		const values = shape?.[field]?._def.values;
		return values?.filter((value): value is string => typeof value === "string") ?? [];
	});
}

function objectLiteralValue(schema: z.ZodType, field: string): string[] {
	const shape = (schema as unknown as { _def: { shape: Record<string, ZodInternal> } })._def.shape;
	return shape[field]._def.values?.filter((value): value is string => typeof value === "string") ?? [];
}

type ZodInternal = { _def: { values?: unknown[] } };

const wireConstants: ReadonlyArray<readonly [string, string | number]> = [
	...Object.entries(ROUTER_PATHS).map(([name, value]) => [`ROUTER_PATH_${name}`, value] as const),
	["CONSOLE_TOKEN_HEADER", CONSOLE_TOKEN_HEADER],
	["BEARER_PREFIX", BEARER_PREFIX],
	...OWNER_OP_KIND_LIST.map((kind) => [`OWNER_OP_${kind}`, kind] as const),
	...Object.entries(SIGNING_TAGS).map(([name, value]) => [`SIGNING_TAG_${name}`, value] as const),
	["OP_OUTCOME_ACCEPTED", OP_OUTCOME_ACCEPTED],
	["BOARD_OUTCOME_APPLIED", BOARD_OUTCOME_APPLIED],
	["CONSOLE_REASON_CURSOR_STALE", CONSOLE_REASON_CURSOR_STALE],
	["GATEWAY_ERROR_STALE_INCARNATION", GATEWAY_ERROR_STALE_INCARNATION],
	["GATEWAY_ERROR_NOT_REGISTERED", GATEWAY_ERROR_NOT_REGISTERED],
	["GATEWAY_ERROR_NOT_ADMITTED", GATEWAY_ERROR_NOT_ADMITTED],
	["GATEWAY_ERROR_INBOX_UNAVAILABLE", GATEWAY_ERROR_INBOX_UNAVAILABLE],
	["GATEWAY_REASON_NO_WAITER", GATEWAY_REASON_NO_WAITER],
	["CONTENT_NONCE_BYTES", CONTENT_NONCE_BYTES],
	["WIRE_NONCE_BYTES", WIRE_NONCE_BYTES],
	["ROUTINE_FORGET_DAYS_DEFAULT", ROUTINE_FORGET_DAYS_DEFAULT],
	["ROUTINE_FORGET_DAYS_MIN", ROUTINE_FORGET_DAYS_MIN],
	["ROUTINE_FORGET_DAYS_MAX", ROUTINE_FORGET_DAYS_MAX],
	["ASSISTANT_RULES_MAX", ASSISTANT_RULES_MAX],
	["ASSISTANT_RULE_CONDITIONS_MAX", ASSISTANT_RULE_CONDITIONS_MAX],
	["ASSISTANT_RULE_VALUE_MAX", ASSISTANT_RULE_VALUE_MAX],
	["ASSISTANT_ROLE", ASSISTANT_ROLE],
	["PHONE_HOLD_PLANE", PHONE_HOLD_PLANE],
	["PHONE_HOLD_WINDOW_MS", PHONE_HOLD_WINDOW_MS],
	["PHONE_CAPABILITY_WAIT_MS", PHONE_CAPABILITY_WAIT_MS],
];
const wireConstantBlock = wireConstants
	.map(
		([name, value]) =>
			`${INDENT}${INDENT}const val ${kotlinConstName(name)}: ${typeof value === "number" ? "Int" : "String"} = ${typeof value === "number" ? value : kotlinString(value)}`,
	)
	.join("\n");
const consoleOpKinds = literalValues(ConsoleOpSchema, "kind");
const socketFrameTypes = literalValues(ConsoleSocketOutboundSchema, "type");
const keyOpKinds = [KeyRequestOpSchema, KeyGrantOpSchema, KeyReceiptOpSchema, KeyReceiptsReadOpSchema].flatMap(
	(schema) => objectLiteralValue(schema, "kind"),
);
const schemaConstantBlock = (name: string, values: string[]) =>
	[
		`${INDENT}${INDENT}object ${name} {`,
		...values.map(
			(value) =>
				`${INDENT}${INDENT}${INDENT}const val ${kotlinConstName(value)}: String = ${kotlinString(value)}`,
		),
		`${INDENT}${INDENT}}`,
	].join("\n");

const GENERATED_HEADER = `// Generated by scripts/codegen-kotlin.ts.
// Do not edit.`;

function emitPhoneCapabilityRegistry(): string {
	const phoneCapabilities = PHONE_CAPABILITY_SPECS.filter(({ key }) => PHONE_CAPABILITIES[key].where === "phone");
	const handlers = phoneCapabilities
		.map(({ key, methodName, requestId, answerId }) => {
			return [
				`${INDENT}suspend fun ${methodName}(`,
				`${INDENT}${INDENT}context: PhoneCapabilityContext,`,
				`${INDENT}${INDENT}request: ${requestId},`,
				`${INDENT}): ${answerId}`,
			].join("\n");
		})
		.join("\n\n");
	const bindings = phoneCapabilities
		.map(({ key, methodName, constantName, requestId, answerId }) => {
			const capability = PHONE_CAPABILITIES[key];
			const needs =
				capability.needs.length === 0
					? "emptyList()"
					: `listOf(${capability.needs.map(kotlinString).join(", ")})`;
			return [
				`${INDENT}${INDENT}bind(`,
				`${INDENT}${INDENT}${INDENT}PhoneCapability(`,
				`${INDENT}${INDENT}${INDENT}${INDENT}key = Protocol.Wire.PhoneCapabilityKey.${constantName},`,
				`${INDENT}${INDENT}${INDENT}${INDENT}kind = ${kotlinString(capability.kind)},`,
				`${INDENT}${INDENT}${INDENT}${INDENT}where = ${kotlinString(capability.where)},`,
				`${INDENT}${INDENT}${INDENT}${INDENT}needs = ${needs},`,
				`${INDENT}${INDENT}${INDENT}${INDENT}label = ${kotlinString(capability.label)},`,
				`${INDENT}${INDENT}${INDENT}${INDENT}requestSerializer = ${requestId}.serializer(),`,
				`${INDENT}${INDENT}${INDENT}${INDENT}answerSerializer = ${answerId}.serializer(),`,
				`${INDENT}${INDENT}${INDENT}${INDENT}handler = handlers::${methodName},`,
				`${INDENT}${INDENT}${INDENT}),`,
				`${INDENT}${INDENT})`,
			].join("\n");
		})
		.join(",\n");
	return `${GENERATED_HEADER}

package com.atelier_nyaarium.switchboard.proto

import com.atelier_nyaarium.switchboard.PhoneCapability
import com.atelier_nyaarium.switchboard.PhoneCapabilityBinding
import com.atelier_nyaarium.switchboard.PhoneCapabilityContext
import com.atelier_nyaarium.switchboard.bind

internal interface PhoneCapabilityHandlers {
${handlers}
}

internal fun phoneCapabilityBindings(handlers: PhoneCapabilityHandlers): Map<String, PhoneCapabilityBinding> =
	listOf<PhoneCapabilityBinding>(
${bindings}
	).associateBy { it.key }
`;
}

/** An enum in the catalogue's own order. */
function emitWireEnum(name: string, values: readonly string[]): string {
	const entries = values.map((value) => `${INDENT}${kotlinConstName(value)}(${kotlinString(value)}),`).join("\n");
	return `internal enum class ${name}(val wire: String) {\n${entries}\n}`;
}

function emitIntegrationRegistry(): string {
	const enumOf = (name: string, value: string) => `${name}.${kotlinConstName(value)}`;
	const entries = INTEGRATION_KEYS.map((key) => {
		const entry = INTEGRATIONS[key];
		const needs = entry.needs
			.map(
				(need) =>
					`IntegrationNeed(${kotlinString(need.key)}, ${enumOf("IntegrationNeedKind", need.kind)}, ${kotlinString(need.label)})`,
			)
			.join(", ");
		const acts = entry.acts
			.map(
				(act) =>
					`IntegrationAct(${kotlinString(act.key)}, ${kotlinString(act.label)}, ${enumOf("ActTier", act.tier)}, ${act.confirm === undefined ? "null" : kotlinString(act.confirm)})`,
			)
			.join(", ");
		const capabilities = entry.capabilities.map((capability) => enumOf("DeviceCapability", capability)).join(", ");
		return [
			`${INDENT}${INDENT}Integration(`,
			`${INDENT}${INDENT}${INDENT}id = ${kotlinString(key)},`,
			`${INDENT}${INDENT}${INDENT}group = ${enumOf("IntegrationGroup", entry.group)},`,
			`${INDENT}${INDENT}${INDENT}label = ${kotlinString(entry.label)},`,
			`${INDENT}${INDENT}${INDENT}blurb = ${kotlinString(entry.blurb)},`,
			`${INDENT}${INDENT}${INDENT}discovery = ${enumOf("IntegrationDiscovery", entry.discovery)},`,
			`${INDENT}${INDENT}${INDENT}needs = listOf(${needs}),`,
			`${INDENT}${INDENT}${INDENT}yields = ${enumOf("IntegrationYield", entry.yields)},`,
			`${INDENT}${INDENT}${INDENT}capabilities = listOf(${capabilities}),`,
			`${INDENT}${INDENT}${INDENT}acts = listOf(${acts}),`,
			`${INDENT}${INDENT}),`,
		].join("\n");
	}).join("\n");
	return `${GENERATED_HEADER}

package com.atelier_nyaarium.switchboard.proto

${emitWireEnum("IntegrationGroup", INTEGRATION_GROUPS)}

${emitWireEnum("IntegrationDiscovery", INTEGRATION_DISCOVERIES)}

${emitWireEnum("IntegrationYield", INTEGRATION_YIELDS)}

${emitWireEnum("IntegrationNeedKind", INTEGRATION_NEED_KINDS)}

${emitWireEnum("DeviceCapability", DEVICE_CAPABILITIES)}

${emitWireEnum("ActTier", ACT_TIERS)}

internal data class IntegrationNeed(val key: String, val kind: IntegrationNeedKind, val label: String)

internal data class IntegrationAct(val key: String, val label: String, val tier: ActTier, val confirm: String?)

internal data class Integration(
${INDENT}val id: String,
${INDENT}val group: IntegrationGroup,
${INDENT}val label: String,
${INDENT}val blurb: String,
${INDENT}val discovery: IntegrationDiscovery,
${INDENT}val needs: List<IntegrationNeed>,
${INDENT}val yields: IntegrationYield,
${INDENT}val capabilities: List<DeviceCapability>,
${INDENT}val acts: List<IntegrationAct>,
)

internal val INTEGRATIONS: List<Integration> =
${INDENT}listOf(
${entries}
${INDENT})
`;
}

const blocks: string[] = [];
const declared = new Set<string>();
for (const name of order) {
	const node = defs.get(name);
	if (!node) continue;
	if (!node.properties && !node.oneOf && !node.anyOf) continue;
	if (SEALED_ROOTS.has(name)) {
		const schema = ROOTS.find((s) => idOf(s) === name);
		if (!schema) throw new Error(`sealed root ${name} not in ROOTS`);
		blocks.push(emitSealedClass(name, node, discriminatorOf(schema), defs));
		declared.add(name);
	} else if (node.properties) {
		blocks.push(emitDataClass(name, node, defs));
		declared.add(name);
	}
}

// A union no list names emits nothing at all, so a field typed as it used to fail only at Kotlin
// compile, and only for whoever ran that gate.
for (const name of referenced) {
	if (declared.has(name)) continue;
	throw new Error(`${name} is a field's type and nothing declares it; add it to ROOTS and SEALED_ROOTS`);
}

const header = `// generated from src/shared/schemas.ts + src/shared/console-protocol.ts - DO NOT EDIT.
// Regenerate: bun scripts/codegen-kotlin.ts
// Decode with ignoreUnknownKeys = true. Enum-like fields are open Strings, so a console
// tolerates values newer than its build.
//
// Keep encodeDefaults false: zod .optional() rejects an explicit null. Enabling it MUST pair
// with explicitNulls = false. Required consts become parameters.
//
@file:Suppress("unused")
@file:OptIn(ExperimentalSerializationApi::class)

package com.atelier_nyaarium.switchboard.proto

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object Protocol {
${INDENT}const val CONSOLE_PROTOCOL_VERSION: Int = ${CONSOLE_PROTOCOL_VERSION}
${INDENT}const val CONSOLE_ANSWER_WAIT_MS: Long = ${CONSOLE_ANSWER_WAIT_MS}L
${INDENT}const val CREATE_SESSION_BOUND_MS: Long = ${CREATE_SESSION_BOUND_MS}L
${INDENT}const val FEDERATION_PROTOCOL_FLOOR: Int = ${FEDERATION_PROTOCOL_FLOOR}
${INDENT}const val FEDERATION_PROTOCOL_VERSION: Int = ${FEDERATION_PROTOCOL_VERSION}
${INDENT}const val MAX_HISTORY_COMMITS: Int = ${MAX_HISTORY_COMMITS}
${INDENT}const val DEVICE_MAX_RULES: Int = ${DEVICE_MAX_RULES}

${INDENT}object Wire {
${wireConstantBlock}

${schemaConstantBlock("ConsoleOpKind", consoleOpKinds)}

${schemaConstantBlock("SocketFrame", socketFrameTypes)}

${schemaConstantBlock("KeyOpKind", keyOpKinds)}

${schemaConstantBlock("RecordOutcome", [...ACTION_OUTCOMES])}

${schemaConstantBlock("PhoneCapabilityKey", [...PHONE_CAPABILITY_KEYS])}

${schemaConstantBlock("PhoneUnavailableReason", [...UNAVAILABLE_REASONS])}

${schemaConstantBlock("DeviceKind", [...DEVICE_KINDS])}

${schemaConstantBlock("DeviceDriver", [...DEVICE_DRIVERS])}

${schemaConstantBlock("DeviceState", [...DEVICE_STATES])}

${schemaConstantBlock("DeviceScheduleAction", [...DEVICE_ACTIONS])}

${schemaConstantBlock("DeviceVerb", [...DEVICE_VERBS])}

${schemaConstantBlock("DeviceCloudState", [...DEVICE_CLOUD_STATES])}

${schemaConstantBlock("DeviceRefusalCode", [...DEVICE_REFUSAL_CODES])}

${schemaConstantBlock("DeviceEffect", [...DEVICE_EFFECTS])}

${schemaConstantBlock("KasaSettingKey", [...KASA_SETTING_KEYS])}
${INDENT}}

${INDENT}/** Address and store separator. */
${INDENT}const val ADDRESS_SEP: String = ${kotlinString(ADDRESS_SEP)}

${INDENT}/** Channel key tag. */
${INDENT}const val CONV_TAG: String = ${kotlinString(CONV_TAG)}

${INDENT}/** Broadcast key tag. */
${INDENT}const val NOTICE_TAG: String = ${kotlinString(NOTICE_TAG)}

${INDENT}/** Default session. */
${INDENT}const val DEFAULT_SESSION: String = ${kotlinString(DEFAULT_SESSION)}

${INDENT}/** Address slug pattern. */
${INDENT}const val SLUG_PATTERN: String = ${kotlinString(SLUG_RE.source)}

${INDENT}const val MAX_SLUG_LEN: Int = ${MAX_SLUG_LEN}

${INDENT}const val MAX_CONV_ID_LEN: Int = ${MAX_CONV_ID_LEN}

${INDENT}/** Blob chunk size. */
${INDENT}const val BLOB_CHUNK_BYTES: Int = ${BLOB_CHUNK_BYTES}

${INDENT}/** Blob size limit. Enforced where the bytes land: a stated size is the sender's claim. */
${INDENT}const val MAX_BLOB_BYTES: Long = ${MAX_BLOB_BYTES}

${INDENT}/** Unprompted fetch threshold, not an attachment cap. The wire still carries MAX_BLOB_BYTES. */
${INDENT}const val BOARD_AUTO_DOWNLOAD_MAX_BYTES: Long = ${BOARD_AUTO_DOWNLOAD_MAX_BYTES}

${INDENT}/** Board attachment limit. */
${INDENT}const val BOARD_ATTACHMENTS_MAX: Int = ${BOARD_ATTACHMENTS_MAX}
}`;

const output = `${[header, ...blocks].join("\n\n")}\n`;
const phoneCapabilityRegistryOutput = emitPhoneCapabilityRegistry();
const integrationRegistryOutput = emitIntegrationRegistry();

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, output);
mkdirSync(dirname(PHONE_CAPABILITY_REGISTRY_OUT_PATH), { recursive: true });
writeFileSync(PHONE_CAPABILITY_REGISTRY_OUT_PATH, phoneCapabilityRegistryOutput);
mkdirSync(dirname(INTEGRATION_REGISTRY_OUT_PATH), { recursive: true });
writeFileSync(INTEGRATION_REGISTRY_OUT_PATH, integrationRegistryOutput);
console.log(`Wrote ${OUT_PATH} (${blocks.length} types + constants).`);
console.log(`Wrote ${PHONE_CAPABILITY_REGISTRY_OUT_PATH} (phone capability registry).`);
console.log(`Wrote ${INTEGRATION_REGISTRY_OUT_PATH} (integration registry).`);
