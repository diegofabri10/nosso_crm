# Relatório — AI Chat (vendedor)

- Data: 2025-12-17T15:36:38.453Z

- Org: bfd76e76-0597-49c0-9fc7-1dcaee04b63b
- Usuário: thales@laray.com.br (0dfb28ea-f54e-46f0-881b-818b6480737f)
- Board: 8115e959-be29-4beb-bd72-3c38b020921a
- Provider/Model: openai / gpt-5.2
- RUN_REAL_AI: true

## Cobertura

- Tools detectadas (2): createContact, searchContacts
- Tools NÃO detectadas (26): analyzePipeline, getBoardMetrics, searchDeals, listDealsByStage, listStagnantDeals, listOverdueDeals, getDealDetails, moveDeal, createDeal, updateDeal, markDealAsWon, markDealAsLost, createTask, moveDealsBulk, listActivities, completeActivity, rescheduleActivity, logActivity, addDealNote, listDealNotes, updateContact, getContactDetails, linkDealToContact, listStages, updateStage, reorderStages

## Execução por etapa

| Etapa | Tool esperada | Tools chamadas | Fallback? |
| --- | --- | --- | --- |
| Criar contato | createContact | createContact | não |
| Buscar contato Maria | searchContacts | searchContacts | não |

## Prompts (para auditoria)

### Criar contato

**User prompt:** Crie um contato Maria Yahoo sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d com email maria.sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d@example.com e telefone 11999990000.

**Tools chamadas:** createContact

**Preview:** Contato criado com sucesso ✅ **Maria Yahoo sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d** Email: **maria.sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d@example.com** | Telefone: **11999990000** Se você quiser, já posso vincular esse contato a um deal do seu funil.

### Buscar contato Maria

**User prompt:** Procure contatos com "maria.sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d@example.com".

**Tools chamadas:** searchContacts

**Preview:** Encontrei 1 contato com esse email: **Maria Yahoo sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d** — **maria.sales-team_2c8c20ca-a817-43d7-8968-5de2df51b25d@example.com**, tel. **11999990000**. ✅
