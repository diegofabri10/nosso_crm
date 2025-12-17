#!/usr/bin/env npx tsx
/**
 * 🧪 Chat “real” (AI SDK v6) simulando um vendedor
 *
 * Objetivo
 * - Rodar um roteiro de mensagens (perguntas de vendedor) e deixar o agente responder
 * - Verificar, via stream do AI SDK, quais tools foram chamadas
 * - Exercitar ações reais (mover/ganhar/perder/etc.) no Supabase, com cleanup seguro
 *
 * Requisitos
 * - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY em .env/.env.local
 * - organization_settings com uma API key válida (Google/OpenAI/Anthropic)
 *
 * Uso (recomendado):
 *   RUN_REAL_AI=true npx tsx scripts/test-ai-chat-vendor.ts
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { ModelMessage } from 'ai';

import { loadEnvFile, getSupabaseUrl, getServiceRoleKey, isPlaceholderApiKey } from '../test/helpers/env';
import {
	createSalesTeamFixtures,
	cleanupSalesTeamFixtures,
	type SalesTeamFixtureBundle,
} from '../test/helpers/salesTeamFixtures';
import { createCRMAgent } from '../lib/ai/crmAgent';

type Provider = 'google' | 'openai' | 'anthropic';

type TurnReport = {
	label: string;
	userPrompt: string;
	expectTool?: string;
	calls: string[];
	preview?: string;
	fallbackUsed: boolean;
	fallbackPrompt?: string;
	fallbackCalls?: string[];
	fallbackPreview?: string;
};

function toBool(v: unknown): boolean {
	return String(v || '').toLowerCase() === 'true';
}

function toModelMessage(role: 'user' | 'assistant', content: string): ModelMessage {
	// ModelMessage é o formato que o ToolLoopAgent consome diretamente.
	// Mantemos o conteúdo como string para simplificar (sem multimodal).
	return { role, content };
}

async function resolveOrgAISettings(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
	const supabase = createClient(supabaseUrl, serviceRoleKey);

	const { data: orgSettings, error } = await supabase
		.from('organization_settings')
		.select('ai_provider, ai_model, ai_google_key, ai_openai_key, ai_anthropic_key')
		.eq('organization_id', organizationId)
		.maybeSingle();

	if (error) {
		throw new Error(`Falha ao carregar organization_settings: ${JSON.stringify(error, null, 2)}`);
	}

	const provider = (orgSettings?.ai_provider ?? 'google') as Provider;
	const modelId: string | null = orgSettings?.ai_model ?? null;

	const apiKey: string | null =
		provider === 'google'
			? (orgSettings?.ai_google_key ?? null)
			: provider === 'openai'
				? (orgSettings?.ai_openai_key ?? null)
				: (orgSettings?.ai_anthropic_key ?? null);

	if (isPlaceholderApiKey(apiKey)) {
		const providerLabel = provider === 'google' ? 'Google Gemini' : provider === 'openai' ? 'OpenAI' : 'Anthropic';
		throw new Error(
			`API key não configurada para ${providerLabel} em organization_settings. Configure em Configurações → Inteligência Artificial.`,
		);
	}

	const resolvedModelId =
		modelId || (provider === 'google' ? 'gemini-2.5-flash' : provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-5');

	return { provider, apiKey: apiKey as string, modelId: resolvedModelId };
}

async function runTurn(params: {
	userId: string;
	apiKey: string;
	modelId: string;
	provider: Provider;
	messages: ModelMessage[];
	context: Record<string, unknown>;
	label: string;
	toolCallsBefore: number;
}) {
	const maxRetries = Number(process.env.AI_CHAT_RETRIES ?? '2');
	let last: { raw: string; textPreview: string; calls: string[]; retryNote?: string } | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const agent = await createCRMAgent(
			params.context as any,
			params.userId,
			params.apiKey,
			params.modelId,
			params.provider,
		);

		const g = globalThis as any;
		let textPreview = '';
		let raw = '';
		let error: unknown = null;

		try {
			const result = await agent.generate({
				messages: params.messages,
				options: params.context as any,
			});
			textPreview = String((result as any)?.text ?? '').trim();
		} catch (e) {
			error = e;
			raw = String((e as any)?.message ?? e ?? '').trim();
			textPreview = raw;
		}

		const calls: string[] = Array.isArray(g.__AI_TOOL_CALLS__) ? g.__AI_TOOL_CALLS__.slice(params.toolCallsBefore) : [];
		const rawLower = raw.toLowerCase();
		const retryable =
			!!error &&
			(rawLower.includes('server_error') ||
				rawLower.includes('help.openai.com') ||
				rawLower.includes('request id req_') ||
				rawLower.includes('an error occurred while processing your request') ||
				rawLower.includes('failed after') ||
				rawLower.includes('temporary') ||
				rawLower.includes('timeout') ||
				rawLower.includes('econnreset') ||
				rawLower.includes('rate') ||
				rawLower.includes('429') ||
				rawLower.includes('502') ||
				rawLower.includes('503') ||
				rawLower.includes('504'));

		// Evita re-tentar quando já houve side effects via tools.
		if (retryable && calls.length === 0 && attempt < maxRetries) {
			const waitMs = Math.min(10_000, 750 * 2 ** attempt);
			console.warn(`\n⚠️ Provider instável (tentativa ${attempt + 1}/${maxRetries + 1}). Re-tentando em ${waitMs}ms...`);
			await new Promise((r) => setTimeout(r, waitMs));
			last = { raw, textPreview, calls, retryNote: 'retry' };
			continue;
		}

		console.log('\n------------------------------');
		console.log(`🧑‍💼 Vendedor: ${params.label}`);
		console.log(`🛠️ Tools chamadas: ${calls.length ? calls.join(', ') : '(nenhuma)'} `);

		if (textPreview) {
			const preview = textPreview.replace(/\s+/g, ' ').trim();
			console.log(`🤖 Resposta (preview): ${preview.slice(0, 420)}${preview.length > 420 ? '…' : ''}`);
		}

		return { raw, textPreview, calls, retryNote: attempt ? `retry:${attempt}` : undefined };
	}

	return last ?? { raw: '', textPreview: '', calls: [] };
}

async function main() {
	// Load env like Vitest does
	const nextRoot = process.cwd();
	const repoRoot = `${nextRoot}/..`;
	loadEnvFile(`${repoRoot}/.env`);
	loadEnvFile(`${repoRoot}/.env.local`, { override: true });
	loadEnvFile(`${nextRoot}/.env`);
	loadEnvFile(`${nextRoot}/.env.local`, { override: true });

	const runReal = toBool(process.env.RUN_REAL_AI);
	if (!runReal) {
		console.error('❌ Este script usa IA de verdade (custo/latência). Para rodar, exporte RUN_REAL_AI=true');
		process.exit(1);
	}

	const supabaseUrl = getSupabaseUrl();
	const serviceRoleKey = getServiceRoleKey();
	if (!supabaseUrl || !serviceRoleKey) {
		throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (configure em .env.local).');
	}

	// Para cobrir assignDeal, precisamos de 2 usuários na mesma org.
	// Em muitos ambientes locais só existe 1 usuário, então o default é 1.
	// Para tentar cobrir assignDeal, rode com SALES_CHAT_MIN_USERS=2.
	const desiredMinUsers = Number(process.env.SALES_CHAT_MIN_USERS || 1);
	const wantAssignDeal = desiredMinUsers >= 2;

	const prevMinUsers = process.env.SALES_TEAM_MIN_USERS;
	const prevStrict = process.env.SALES_TEAM_STRICT;
	const prevToolDebug = process.env.AI_TOOL_CALLS_DEBUG;
	const prevApprovalBypass = process.env.AI_TOOL_APPROVAL_BYPASS;

	process.env.SALES_TEAM_MIN_USERS = String(desiredMinUsers);
	// Para scripts, é melhor falhar cedo do que rodar “meia matriz” e descobrir no final.
	process.env.SALES_TEAM_STRICT = String(process.env.SALES_TEAM_STRICT ?? 'true');
	process.env.AI_TOOL_CALLS_DEBUG = 'true';
	process.env.AI_TOOL_APPROVAL_BYPASS = 'true';

	let fx: SalesTeamFixtureBundle | null = null;
	try {
		fx = await createSalesTeamFixtures();

		if (wantAssignDeal && fx.users.length < 2) {
			throw new Error(
				`Não consegui obter 2 usuários reais na mesma organização para cobrir assignDeal. ` +
					`Obtive ${fx.users.length}. ` +
					`Se você quiser rodar mesmo assim, defina SALES_CHAT_MIN_USERS=1 (mas assignDeal ficará de fora).`,
			);
		}

		const seller = fx.users[0];
		const other = wantAssignDeal ? fx.users[1] : null;
		const board = fx.boardsByUserId[seller.userId];
		const bundle = fx.dealsByUserId[seller.userId];
		const tomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const twoDaysFromNowIso = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

		const { provider, apiKey, modelId } = await resolveOrgAISettings(supabaseUrl, serviceRoleKey, fx.organizationId);

		const context = {
			organizationId: fx.organizationId,
			boardId: board.boardId,
			boardName: `AI Tools Test Board ${seller.firstName}`,
			dealId: bundle.openDealId,
			wonStage: 'Ganho',
			lostStage: 'Perdido',
			stages: [
				{ id: board.stageIds.novo, name: 'Novo' },
				{ id: board.stageIds.proposta, name: 'Proposta' },
				{ id: board.stageIds.ganho, name: 'Ganho' },
				{ id: board.stageIds.perdido, name: 'Perdido' },
			],
			userId: seller.userId,
			userName: seller.nickname || seller.firstName,
			userRole: seller.role,
		};

		const messages: ModelMessage[] = [];
		const turns: TurnReport[] = [];

		type ScriptStep = {
			label: string;
			user: string;
			userHuman?: string;
			expectTool?: string;
			fallbackUser?: string;
		};

		const humanPrompts = toBool(process.env.SALES_CHAT_HUMAN_PROMPTS);
		const humanTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // "2025-12-17T15-44-15"

		let script: ScriptStep[] = [
			{
				label: 'Analise meu pipeline',
				user: 'Analise meu pipeline desse board e me diga pontos de atenção.',
				expectTool: 'analyzePipeline',
				fallbackUser: `Execute analyzePipeline com boardId: ${board.boardId}. Sem texto extra.`,
			},
			{
				label: 'Métricas do board',
				user: 'Quais são as métricas desse board agora?',
				expectTool: 'getBoardMetrics',
				fallbackUser: `Execute getBoardMetrics com boardId: ${board.boardId}.`,
			},
			{
				label: 'Buscar deals (Yahoo)',
				user: `Busque deals com "${fx.runId.split('_')[0]}" no título.`,
				expectTool: 'searchDeals',
				fallbackUser: `Execute searchDeals com query: "${fx.runId.split('_')[0]}" e limit: 5.`,
			},
			{
				label: 'Buscar contatos (email fixture)',
				user: `Procure contatos com o email ${bundle.contactEmail}.`,
				expectTool: 'searchContacts',
				fallbackUser: `Execute searchContacts com query: "${bundle.contactEmail}" e limit: 5.`,
			},
			{
				label: 'Deals por estágio',
				user: 'Quantos deals eu tenho no estágio Novo?',
				expectTool: 'listDealsByStage',
				fallbackUser: `Execute listDealsByStage com boardId: ${board.boardId} e stageId: ${board.stageIds.novo} e limit: 10.`,
			},
			{
				label: 'Deals parados',
				user:
					`Use a tool listStagnantDeals agora, com boardId: ${board.boardId}, daysStagnant: 7, limit: 10. ` +
					`Não faça perguntas e não explique; apenas execute a tool e traga o resultado.`,
				expectTool: 'listStagnantDeals',
				fallbackUser:
					`Execute listStagnantDeals imediatamente com boardId: ${board.boardId}, daysStagnant: 1, limit: 10. ` +
					`Sem texto extra.`,
			},
			{
				label: 'Deals atrasados',
				user: 'Quais deals têm atividades atrasadas?',
				expectTool: 'listOverdueDeals',
				fallbackUser: `Execute listOverdueDeals com boardId: ${board.boardId} e limit: 10.`,
			},
			{
				label: 'Detalhes do deal',
				user: 'Me dê os detalhes do deal atual.',
				expectTool: 'getDealDetails',
				fallbackUser: `Execute getDealDetails com dealId: ${bundle.openDealId}.`,
			},
			{
				label: 'Mover para Proposta',
				user: `Mova o deal (dealId: ${bundle.openDealId}) para o estágio Proposta (stageId: ${board.stageIds.proposta}). Use moveDeal.`,
				userHuman: 'Move o deal atual para o estágio Proposta.',
				expectTool: 'moveDeal',
				fallbackUser: `Execute moveDeal com dealId: ${bundle.openDealId} e stageId: ${board.stageIds.proposta}.`,
			},
			{
				label: 'Criar deal Yahoo',
				user: `Crie um deal chamado Yahoo ${fx.runId} com valor 5000 e contato "Yahoo".`,
				userHuman: `Crie um deal chamado "Yahoo ${humanTag}" com valor 5000 e contato "Yahoo".`,
				expectTool: 'createDeal',
				fallbackUser: `Execute createDeal com title: "Yahoo ${fx.runId}", value: 5000 e contactName: "Yahoo".`,
			},
			{
				label: 'Atualizar deal',
				user:
					`Atualize o deal (dealId: ${bundle.openDealId}) definindo o title para "AI Tools Deal Open - Renovação ${fx.runId}". ` +
					'Use updateDeal e não peça confirmação.',
				userHuman: `Atualize o título do deal atual para "Renovação (Yahoo) ${humanTag}".`,
				expectTool: 'updateDeal',
				fallbackUser:
					`Execute updateDeal com dealId: ${bundle.openDealId} e title: "AI Tools Deal Open - Renovação ${fx.runId}". ` +
					'Agora.',
			},
			{
				label: 'Criar tarefa',
				user: `Crie uma tarefa (title: "Ligar amanhã - follow-up", dueDate: ${tomorrowIso}, type: CALL, dealId: ${bundle.openDealId}). Use createTask.`,
				userHuman: 'Crie uma tarefa de ligação para amanhã chamada "Ligar amanhã - follow-up" para o deal atual.',
				expectTool: 'createTask',
				fallbackUser: `Execute createTask com title: "Ligar amanhã - follow-up", dueDate: "${tomorrowIso}", type: "CALL" e dealId: "${bundle.openDealId}".`,
			},
			{
				label: 'Listar atividades',
				user: 'Liste minhas atividades desse deal.',
				expectTool: 'listActivities',
				fallbackUser: `Execute listActivities com dealId: ${bundle.openDealId}.`,
			},
			{
				label: 'Reagendar atividade',
				user: `Reagende a atividade (activityId: ${bundle.futureActivityId}) para newDate ${twoDaysFromNowIso}. Use rescheduleActivity.`,
				userHuman: `Reagende a próxima atividade desse deal para daqui a 2 dias.`,
				expectTool: 'rescheduleActivity',
				fallbackUser: `Execute rescheduleActivity com activityId: ${bundle.futureActivityId} e newDate: "${twoDaysFromNowIso}".`,
			},
			{
				label: 'Completar atividade',
				user: `Marque como concluída a atividade (activityId: ${bundle.overdueActivityId}). Use completeActivity.`,
				userHuman: 'Marque como concluída a atividade atrasada desse deal.',
				expectTool: 'completeActivity',
				fallbackUser: `Execute completeActivity com activityId: ${bundle.overdueActivityId}.`,
			},
			{
				label: 'Logar atividade',
				user: 'Registre uma ligação realizada agora para esse deal.',
				expectTool: 'logActivity',
				fallbackUser: `Execute logActivity com dealId: ${bundle.openDealId} e type: "CALL" e title: "Ligação realizada".`,
			},
			{
				label: 'Adicionar nota',
				user: 'Adicione uma nota nesse deal: "Cliente pediu proposta atualizada".',
				expectTool: 'addDealNote',
				fallbackUser: `Execute addDealNote com dealId: ${bundle.openDealId} e note: "Cliente pediu proposta atualizada".`,
			},
			{
				label: 'Listar notas',
				user: 'Liste as notas desse deal.',
				expectTool: 'listDealNotes',
				fallbackUser: `Execute listDealNotes com dealId: ${bundle.openDealId} e limit: 10.`,
			},
			{
				label: 'Criar contato',
				user: `Crie um contato Maria Yahoo ${fx.runId} com email maria.${fx.runId}@example.com e telefone 11999990000.`,
				userHuman: `Crie um novo contato da Maria Yahoo (email maria.${humanTag}@example.com, tel 11999990000).`,
				expectTool: 'createContact',
				fallbackUser: `Execute createContact com name: "Maria Yahoo ${fx.runId}", email: "maria.${fx.runId}@example.com" e phone: "11999990000".`,
			},
			{
				label: 'Buscar contato Maria',
				user: `Procure contatos com "maria.${fx.runId}@example.com".`,
				userHuman: `Procure o contato da Maria pelo email maria.${humanTag}@example.com.`,
				expectTool: 'searchContacts',
				fallbackUser: `Execute searchContacts com query: "maria.${fx.runId}@example.com" e limit: 5.`,
			},
			{
				label: 'Detalhar contato',
				user: `Mostre detalhes do contato (contactId: ${bundle.contactId}).`,
				userHuman: 'Mostre os detalhes do contato principal (o lead que estamos usando).',
				expectTool: 'getContactDetails',
				fallbackUser: `Execute getContactDetails com contactId: ${bundle.contactId}.`,
			},
			{
				label: 'Atualizar contato',
				user:
					`Use updateContact agora com contactId: ${bundle.contactId} e notes: "Lead quente (${fx.runId})". ` +
					`Não altere email/telefone/nome e não peça confirmação em texto.`,
				userHuman: `Atualize as notas do contato principal para "Lead quente (${humanTag})" sem alterar os outros campos.`,
				expectTool: 'updateContact',
				fallbackUser:
					`Se precisar, use getContactDetails (contactId: ${bundle.contactId}) e em seguida execute updateContact ` +
					`com contactId: ${bundle.contactId} e notes: "Lead quente (${fx.runId})". Sem perguntas.`,
			},
			{
				label: 'Link deal -> contato',
				user:
					`Vincule o deal (dealId: ${bundle.openDealId}) ao contato (contactId: ${bundle.contactId}). ` +
					'Use linkDealToContact e não pergunte nada.',
				expectTool: 'linkDealToContact',
				fallbackUser:
					`Execute linkDealToContact com dealId: ${bundle.openDealId} e contactId: ${bundle.contactId}. ` +
					'Agora.',
			},
			{
				label: 'Bulk move',
				user: `Mova em lote (bulk) os deals [${bundle.openDealId}, ${bundle.lostDealId}] para o estágio Proposta (stageId: ${board.stageIds.proposta}). Use moveDealsBulk.`,
				userHuman: 'Mova em lote dois deals (o aberto e o que vai virar perdido) para Proposta.',
				expectTool: 'moveDealsBulk',
				fallbackUser: `Execute moveDealsBulk com dealIds: ["${bundle.openDealId}", "${bundle.lostDealId}"] e stageId: "${board.stageIds.proposta}".`,
			},
			{
				label: 'Listar estágios',
				user: 'Liste os estágios desse board.',
				expectTool: 'listStages',
				fallbackUser: `Execute listStages com boardId: ${board.boardId}.`,
			},
			{
				label: 'Atualizar estágio',
				user: 'Atualize o label do estágio Proposta para "Proposta Enviada".',
				expectTool: 'updateStage',
				fallbackUser: `Execute updateStage com stageId: ${board.stageIds.proposta} e label: "Proposta Enviada".`,
			},
			{
				label: 'Reordenar estágios',
				user:
					`Reordene os estágios do board usando orderedStageIds exatamente nesta ordem: ` +
					`[${board.stageIds.novo}, ${board.stageIds.proposta}, ${board.stageIds.ganho}, ${board.stageIds.perdido}]. ` +
					'Use APENAS a tool reorderStages e não execute nenhuma outra tool.',
				userHuman: 'Reordene os estágios do funil para: Novo → Proposta → Ganho → Perdido.',
				expectTool: 'reorderStages',
				fallbackUser:
					`Chame APENAS reorderStages agora com { ` +
					`boardId: "${board.boardId}", ` +
					`orderedStageIds: ["${board.stageIds.novo}", "${board.stageIds.proposta}", "${board.stageIds.ganho}", "${board.stageIds.perdido}"] ` +
					`}. Sem texto extra.`,
			},
			{
				label: 'Marcar como ganho',
				user: `Marque como ganho o deal (dealId: ${bundle.wonDealId}) com wonValue 2000.`,
				userHuman: 'Marque como ganho o deal que estava como WonCandidate com valor final 2000.',
				expectTool: 'markDealAsWon',
				fallbackUser: `Execute markDealAsWon com dealId: ${bundle.wonDealId} e wonValue: 2000.`,
			},
			{
				label: 'Marcar como perdido',
				user: `Marque como perdido o deal (dealId: ${bundle.lostDealId}) com reason "Preço".`,
				userHuman: 'Marque como perdido o deal que estava como LostCandidate com motivo "Preço".',
				expectTool: 'markDealAsLost',
				fallbackUser: `Execute markDealAsLost com dealId: ${bundle.lostDealId} e reason: "Preço".`,
			},
		];

		// Permite rodar um subconjunto das etapas para depuração.
		// Ex.: SALES_CHAT_ONLY_LABELS="Buscar contato Maria" ou SALES_CHAT_ONLY_LABELS="Atualizar estágio"
		const onlyLabelsRaw = String(process.env.SALES_CHAT_ONLY_LABELS || '').trim();
		if (onlyLabelsRaw) {
			const requested = new Set(
				onlyLabelsRaw
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
			);

			// Pré-requisitos mínimos para reproduzir fielmente o cenário de certas etapas.
			// - "Buscar contato Maria" depende do contato Maria ter sido criado na etapa anterior.
			if (requested.has('Buscar contato Maria')) requested.add('Criar contato');
			// - "Atualizar estágio" fica mais estável se o agente tiver listado estágios antes.
			if (requested.has('Atualizar estágio')) requested.add('Listar estágios');

			script = script.filter((s) => requested.has(s.label));
			if (script.length === 0) {
				throw new Error(
					`SALES_CHAT_ONLY_LABELS foi definido, mas nenhuma etapa foi encontrada. ` +
					`Labels disponíveis incluem: ${[
						'Buscar contato Maria',
						'Atualizar estágio',
						'Criar contato',
						'Listar estágios',
					].join(', ')}`,
				);
			}
		}

		if (wantAssignDeal && other) {
			script.push({ label: 'Reatribuir deal', user: `Reatribua esse deal para outro responsável (userId: ${other.userId}).` });
		}

		const allToolsDetected = new Set<string>();

		for (const step of script) {
			// Envia o prompt do usuário desta etapa para o agente.
			// Sem isso, a primeira chamada pode falhar com "messages must not be empty"
			// e as etapas seguintes ficam sem contexto (o agente só veria placeholders).
			const effectiveUserPrompt = humanPrompts && step.userHuman ? step.userHuman : step.user;
			messages.push(toModelMessage('user', effectiveUserPrompt));

			const g = globalThis as any;
			const before = Array.isArray(g.__AI_TOOL_CALLS__) ? g.__AI_TOOL_CALLS__.length : 0;

			const parsed = await runTurn({
				userId: seller.userId,
				apiKey,
				modelId,
				provider,
				messages,
				context,
				label: step.label,
				toolCallsBefore: before,
			});

			parsed.calls.forEach((t) => allToolsDetected.add(t));
			// Evita que outputs longos (JSON / tool results) contaminem as próximas decisões do modelo.
			messages.push(toModelMessage('assistant', '(ok)'));

			const turn: TurnReport = {
				label: step.label,
				userPrompt: effectiveUserPrompt,
				expectTool: step.expectTool,
				calls: parsed.calls,
				preview: parsed.textPreview ? parsed.textPreview.replace(/\s+/g, ' ').trim().slice(0, 420) : undefined,
				fallbackUsed: false,
			};

			if (step.expectTool && !parsed.calls.includes(step.expectTool) && step.fallbackUser) {
				messages.push(toModelMessage('user', step.fallbackUser));
				const beforeFallback = Array.isArray(g.__AI_TOOL_CALLS__) ? g.__AI_TOOL_CALLS__.length : 0;
				const parsedFallback = await runTurn({
					userId: seller.userId,
					apiKey,
					modelId,
					provider,
					messages,
					context,
					label: `${step.label} (fallback)`,
					toolCallsBefore: beforeFallback,
				});
				parsedFallback.calls.forEach((t) => allToolsDetected.add(t));
				messages.push(toModelMessage('assistant', '(ok)'));

				turn.fallbackUsed = true;
				turn.fallbackPrompt = step.fallbackUser;
				turn.fallbackCalls = parsedFallback.calls;
				turn.fallbackPreview = parsedFallback.textPreview
					? parsedFallback.textPreview.replace(/\s+/g, ' ').trim().slice(0, 420)
					: undefined;
			}

			turns.push(turn);

			await new Promise((r) => setTimeout(r, 400));
		}

		const expectedBase = [
			'analyzePipeline',
			'getBoardMetrics',
			'searchDeals',
			'searchContacts',
			'listDealsByStage',
			'listStagnantDeals',
			'listOverdueDeals',
			'getDealDetails',
			'moveDeal',
			'createDeal',
			'updateDeal',
			'markDealAsWon',
			'markDealAsLost',
			'createTask',
			'moveDealsBulk',
			'listActivities',
			'completeActivity',
			'rescheduleActivity',
			'logActivity',
			'addDealNote',
			'listDealNotes',
			'createContact',
			'updateContact',
			'getContactDetails',
			'linkDealToContact',
			'listStages',
			'updateStage',
			'reorderStages',
		] as const;

		const expected = (wantAssignDeal
			? ([...expectedBase, 'assignDeal'] as const)
			: expectedBase) as readonly string[];

		const missing = expected.filter((t) => !allToolsDetected.has(t));

		console.log('\n==============================');
		console.log('📌 RESUMO');
		console.log('==============================');
		console.log(`Org: ${fx.organizationId}`);
		console.log(`Vendedor: ${seller.email} (${seller.userId})`);
		console.log(`Board: ${board.boardId}`);
		console.log(`Tools detectadas (${allToolsDetected.size}): ${Array.from(allToolsDetected).sort().join(', ')}`);

		if (missing.length) {
			console.log(`\n⚠️ Tools NÃO detectadas no chat (${missing.length}): ${missing.join(', ')}`);
			console.log('Dica: como o modelo decide o plano, pode variar. Ajuste o roteiro/linguagem das prompts para forçar chamadas.');
			// Se estivermos rodando apenas um subconjunto (debug), é esperado não cobrir tudo.
			if (!onlyLabelsRaw) process.exitCode = 2;
		} else {
			console.log('\n✅ Todas as tools foram detectadas via chat.');
		}

		// Relatório em Markdown (útil para “cadê a bateria de testes?”)
		try {
			const baseDir = path.join(process.cwd(), 'testsprite_tests', 'tmp');
			await mkdir(baseDir, { recursive: true });
			const reportPath =
				process.env.AI_CHAT_REPORT_PATH?.trim() ||
				path.join(baseDir, `ai-chat-vendor-report.${fx.runId}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);

			const now = new Date();
			const lines: string[] = [];
			lines.push(`# Relatório — AI Chat (vendedor)\n`);
			lines.push(`- Data: ${now.toISOString()}\n`);
			lines.push(`- Org: ${fx.organizationId}`);
			lines.push(`- Usuário: ${seller.email} (${seller.userId})`);
			lines.push(`- Board: ${board.boardId}`);
			lines.push(`- Provider/Model: ${provider} / ${modelId}`);
			lines.push(`- RUN_REAL_AI: ${String(process.env.RUN_REAL_AI)}`);
			lines.push('');

			lines.push(`## Cobertura\n`);
			lines.push(`- Tools detectadas (${allToolsDetected.size}): ${Array.from(allToolsDetected).sort().join(', ')}`);
			lines.push(`- Tools NÃO detectadas (${missing.length}): ${missing.length ? missing.join(', ') : '(nenhuma)'}`);
			lines.push('');

			lines.push('## Execução por etapa\n');
			lines.push('| Etapa | Tool esperada | Tools chamadas | Fallback? |');
			lines.push('| --- | --- | --- | --- |');
			for (const t of turns) {
				const called = [...(t.calls || []), ...((t.fallbackCalls || []) as string[])].filter(Boolean);
				const calledUnique = Array.from(new Set(called));
				lines.push(
					`| ${t.label.replace(/\|/g, '\\|')} | ${t.expectTool ?? ''} | ${calledUnique.join(', ')} | ${t.fallbackUsed ? 'sim' : 'não'} |`,
				);
			}
			lines.push('');

			lines.push('## Prompts (para auditoria)\n');
			for (const t of turns) {
				lines.push(`### ${t.label}\n`);
				lines.push(`**User prompt:** ${t.userPrompt}`);
				lines.push(`\n**Tools chamadas:** ${t.calls.length ? t.calls.join(', ') : '(nenhuma)'}`);
				if (t.preview) lines.push(`\n**Preview:** ${t.preview}`);
				if (t.fallbackUsed) {
					lines.push(`\n**Fallback prompt:** ${t.fallbackPrompt}`);
					lines.push(`\n**Tools no fallback:** ${t.fallbackCalls?.length ? t.fallbackCalls.join(', ') : '(nenhuma)'}`);
					if (t.fallbackPreview) lines.push(`\n**Preview fallback:** ${t.fallbackPreview}`);
				}
				lines.push('');
			}

			await writeFile(reportPath, lines.join('\n'), 'utf8');
			console.log(`\n🧾 Relatório salvo em: ${reportPath}`);
		} catch (e) {
			console.warn('⚠️ Não consegui salvar o relatório (best-effort):', e);
		}
	} finally {
		if (fx) await cleanupSalesTeamFixtures(fx);
		if (prevMinUsers === undefined) delete process.env.SALES_TEAM_MIN_USERS;
		else process.env.SALES_TEAM_MIN_USERS = prevMinUsers;

		if (prevStrict === undefined) delete process.env.SALES_TEAM_STRICT;
		else process.env.SALES_TEAM_STRICT = prevStrict;

		if (prevToolDebug === undefined) delete process.env.AI_TOOL_CALLS_DEBUG;
		else process.env.AI_TOOL_CALLS_DEBUG = prevToolDebug;

		if (prevApprovalBypass === undefined) delete process.env.AI_TOOL_APPROVAL_BYPASS;
		else process.env.AI_TOOL_APPROVAL_BYPASS = prevApprovalBypass;
	}
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
