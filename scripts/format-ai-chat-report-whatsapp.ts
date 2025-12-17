#!/usr/bin/env npx tsx
/**
 * Converte o relatório Markdown gerado pelo `test-ai-chat-vendor.ts`
 * para um texto "WhatsApp-friendly".
 *
 * Regras de formatação (WhatsApp):
 * - Negrito: *texto*
 * - Itálico: _texto_
 * - Riscado: ~texto~
 * - Monoespaçado: ```texto```
 * - Código inline: `texto`
 * - Lista com marcas: - texto (ou * texto)
 * - Lista numerada: 1. texto
 * - Citação: > texto
 *
 * Uso:
 *   npx tsx scripts/format-ai-chat-report-whatsapp.ts [caminho-do-relatorio.md]
 *
 * Se nenhum caminho for passado, usa o relatório mais recente em testsprite_tests/tmp.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs/promises';

type StepRow = {
	label: string;
	expectedTool: string;
	calledTools: string;
	fallback: 'sim' | 'não' | '';
};

type PromptAudit = {
	label: string;
	userPrompt?: string;
	toolsCalled?: string;
	preview?: string;
	fallbackPrompt?: string;
	fallbackTools?: string;
	fallbackPreview?: string;
};

function trimOrEmpty(v: string | undefined | null) {
	return String(v ?? '').trim();
}

function collapseWs(s: string) {
	return s.replace(/\s+/g, ' ').trim();
}

function normalizeForWhatsApp(text: string) {
	// Converte negrito Markdown (**texto**) para negrito do WhatsApp (*texto*).
	let t = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
	// Remove fences de código (elas são comuns no Markdown e atrapalham no WhatsApp).
	t = t
		.split(/\r?\n/)
		.filter((l) => !l.trim().startsWith('```'))
		.join('\n');
	return t;
}

function redactSensitive(text: string) {
	let t = text;
	// runId (nosso token de execução)
	t = t.replace(/sales-team_[0-9a-f-]+/gi, 'sales-team_[run]');
	// UUIDs
	t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]');
	// emails
	t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
	return t;
}

async function findLatestReportMd(): Promise<string> {
	const dir = path.join(process.cwd(), 'testsprite_tests', 'tmp');
	const entries = await fs.readdir(dir);
	const candidates = entries
		.filter((f) => f.startsWith('ai-chat-vendor-report.') && f.endsWith('.md'))
		.map((f) => path.join(dir, f));

	if (!candidates.length) {
		throw new Error(`Nenhum relatório encontrado em ${dir} (ai-chat-vendor-report.*.md)`);
	}

	const stats = await Promise.all(
		candidates.map(async (p) => ({ p, st: await fs.stat(p) })),
	);
	stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
	return stats[0].p;
}

function parseCoverage(lines: string[]) {
	let detectedLine = '';
	let missingLine = '';
	for (const l of lines) {
		if (l.startsWith('- Tools detectadas')) detectedLine = l;
		if (l.startsWith('- Tools NÃO detectadas')) missingLine = l;
	}
	return { detectedLine, missingLine };
}

function parseStepsTable(lines: string[]): StepRow[] {
	const out: StepRow[] = [];
	const headerIdx = lines.findIndex((l) => l.trim() === '| Etapa | Tool esperada | Tools chamadas | Fallback? |');
	if (headerIdx === -1) return out;

	for (let i = headerIdx + 2; i < lines.length; i++) {
		const l = lines[i];
		if (!l.startsWith('|')) break;
		// | label | expected | called | fallback |
		const parts = l
			.split('|')
			.slice(1, -1)
			.map((p) => p.trim());
		if (parts.length < 4) continue;
		const fbRaw = parts[3]?.trim().toLowerCase();
		const fallback: StepRow['fallback'] = fbRaw === 'sim' ? 'sim' : fbRaw === 'não' || fbRaw === 'nao' ? 'não' : '';
		out.push({
			label: parts[0],
			expectedTool: parts[1],
			calledTools: parts[2],
			fallback,
		});
	}

	return out;
}

function parsePromptAudits(lines: string[]): Map<string, PromptAudit> {
	const map = new Map<string, PromptAudit>();
	const startIdx = lines.findIndex((l) => l.trim() === '## Prompts (para auditoria)');
	if (startIdx === -1) return map;

	let current: PromptAudit | null = null;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const l = lines[i];
		if (l.startsWith('### ')) {
			if (current) map.set(current.label, current);
			current = { label: l.replace(/^###\s+/, '').trim() };
			continue;
		}
		if (!current) continue;

		const user = l.match(/^\*\*User prompt:\*\*\s*(.*)$/);
		if (user) current.userPrompt = user[1];

		const tools = l.match(/^\*\*Tools chamadas:\*\*\s*(.*)$/);
		if (tools) current.toolsCalled = tools[1];

		const prev = l.match(/^\*\*Preview:\*\*\s*(.*)$/);
		if (prev) current.preview = prev[1];

		const fbp = l.match(/^\*\*Fallback prompt:\*\*\s*(.*)$/);
		if (fbp) current.fallbackPrompt = fbp[1];

		const fbt = l.match(/^\*\*Tools no fallback:\*\*\s*(.*)$/);
		if (fbt) current.fallbackTools = fbt[1];

		const fprev = l.match(/^\*\*Preview fallback:\*\*\s*(.*)$/);
		if (fprev) current.fallbackPreview = fprev[1];
	}
	if (current) map.set(current.label, current);

	return map;
}

function formatWhatsAppText(params: {
	reportPath: string;
	titleLine: string;
	metaLines: string[];
	coverage: { detectedLine: string; missingLine: string };
	steps: StepRow[];
	audits: Map<string, PromptAudit>;
	includeAudit: 'none' | 'fallbacks' | 'all';
	truncatePreviews: boolean;
}) {
	const { reportPath, titleLine, metaLines, coverage, steps, audits, includeAudit, truncatePreviews } = params;
	const out: string[] = [];

	const title = titleLine.replace(/^#\s+/, '').trim() || 'Relatório';
	out.push(`*${title}*`);
	out.push('');

	for (const l of metaLines) {
		const clean = l.replace(/^[-•]\s*/, '').trim();
		if (clean) out.push(clean);
	}
	out.push(`Arquivo origem: ${path.basename(reportPath)}`);
	out.push('');

	out.push('*Cobertura*');
	if (coverage.detectedLine) out.push(coverage.detectedLine.replace(/^[-•]\s*/, '- '));
	if (coverage.missingLine) out.push(coverage.missingLine.replace(/^[-•]\s*/, '- '));
	out.push('');

	out.push(`*Execução por etapa* (${steps.length})`);
	steps.forEach((s, idx) => {
		out.push(`${idx + 1}. *${s.label}*`);
		if (s.expectedTool) out.push(`   - Esperada: \`${s.expectedTool}\``);
		if (s.calledTools) out.push(`   - Chamadas: \`${s.calledTools}\``);
		out.push(`   - Fallback: ${s.fallback?.toUpperCase?.() ?? s.fallback}`);
	});
	out.push('');

	const fallbackSteps = steps.filter((s) => s.fallback === 'sim');
	out.push(`*Fallbacks* (${fallbackSteps.length})`);
	if (!fallbackSteps.length) {
		out.push('- (nenhum)');
		out.push('');
	} else {
		for (const s of fallbackSteps) {
			const audit = audits.get(s.label);
			let reason = '';
			const preview = collapseWs(trimOrEmpty(audit?.preview));
			if (!preview) {
				reason = 'Modelo não chamou a tool no passo principal.';
			} else if (preview.toLowerCase().includes('failed after') || preview.toLowerCase().includes('an error occurred')) {
				reason = `Instabilidade do provider: ${preview}`;
			} else if (preview.toLowerCase().includes('não consegui') || preview.toLowerCase().includes('nao consegui')) {
				reason = preview;
			} else {
				reason = preview;
			}
			if (truncatePreviews) {
				out.push(`- *${s.label}* — ${reason.slice(0, 220)}${reason.length > 220 ? '…' : ''}`);
			} else {
				out.push(`- *${s.label}* — ${reason}`);
			}
		}
		out.push('');
	}

	if (includeAudit !== 'none') {
		out.push('*Auditoria*');
		out.push(`(incluindo: ${includeAudit === 'all' ? 'todas as etapas' : 'somente etapas com fallback'})`);
		out.push('');

		const auditLabels = includeAudit === 'all' ? steps.map((s) => s.label) : fallbackSteps.map((s) => s.label);
		for (const label of auditLabels) {
			const a = audits.get(label);
			if (!a) continue;
			out.push(`> *${label}*`);
			if (a.userPrompt) out.push(`User: ${a.userPrompt}`);
			if (a.toolsCalled) out.push(`Tools: ${a.toolsCalled}`);
			if (a.preview) {
				if (truncatePreviews) {
					out.push(`Preview: ${collapseWs(a.preview).slice(0, 260)}${a.preview.length > 260 ? '…' : ''}`);
				} else {
					out.push(`Preview: ${a.preview}`);
				}
			}
			if (a.fallbackPrompt) out.push(`Fallback prompt: ${a.fallbackPrompt}`);
			if (a.fallbackTools) out.push(`Fallback tools: ${a.fallbackTools}`);
			if (a.fallbackPreview) {
				if (truncatePreviews) {
					out.push(
						`Fallback preview: ${collapseWs(a.fallbackPreview).slice(0, 260)}${a.fallbackPreview.length > 260 ? '…' : ''}`,
					);
				} else {
					out.push(`Fallback preview: ${a.fallbackPreview}`);
				}
			}
			out.push('');
		}
	}

	return out.join('\n');
}

async function main() {
	const argPath = process.argv[2];
	const reportPath = argPath ? path.resolve(process.cwd(), argPath) : await findLatestReportMd();
	const completeMode =
		String(process.env.WHATSAPP_COMPLETE ?? '').toLowerCase() === 'true' ||
		String(process.env.WHATSAPP_MODE ?? '').toLowerCase() === 'complete';
	const includeAudit = (completeMode ? 'all' : process.env.WHATSAPP_INCLUDE_AUDIT ?? 'fallbacks') as
		| 'none'
		| 'fallbacks'
		| 'all';
	const redact = String(process.env.WHATSAPP_REDACT ?? 'true').toLowerCase() !== 'false';

	const raw = await readFile(reportPath, 'utf8');
	const lines = raw.split(/\r?\n/);

	const titleLine = lines.find((l) => l.startsWith('# ')) ?? '# Relatório';

	// Metadata: linhas com "- " antes da seção "## Cobertura"
	const coverageIdx = lines.findIndex((l) => l.trim() === '## Cobertura');
	const metaLines = coverageIdx === -1 ? [] : lines.slice(0, coverageIdx).filter((l) => l.trim().startsWith('- '));

	const coverageBlock: string[] = [];
	if (coverageIdx !== -1) {
		for (let i = coverageIdx + 1; i < lines.length; i++) {
			const l = lines[i];
			if (l.startsWith('## ') && i !== coverageIdx) break;
			if (l.trim().startsWith('- ')) coverageBlock.push(l.trim());
		}
	}

	const coverage = parseCoverage(coverageBlock);
	const steps = parseStepsTable(lines);
	const audits = parsePromptAudits(lines);

	let text = formatWhatsAppText({
		reportPath,
		titleLine,
		metaLines,
		coverage,
		steps,
		audits,
		includeAudit,
		truncatePreviews: !completeMode,
	});

	text = normalizeForWhatsApp(text);
	if (redact) text = redactSensitive(text);

	const outPath = reportPath.replace(/\.md$/i, completeMode ? '.whatsapp.full.txt' : '.whatsapp.txt');
	await writeFile(outPath, text, 'utf8');
	console.log(outPath);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
