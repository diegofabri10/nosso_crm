# Relatório — AI Chat (vendedor)

- Data: 2025-12-17T15:37:46.299Z

- Org: bfd76e76-0597-49c0-9fc7-1dcaee04b63b
- Usuário: thales@laray.com.br (0dfb28ea-f54e-46f0-881b-818b6480737f)
- Board: d9391f79-7b49-4740-b90c-99101e6d1392
- Provider/Model: openai / gpt-5.2
- RUN_REAL_AI: true

## Cobertura

- Tools detectadas (2): listStages, updateStage
- Tools NÃO detectadas (26): analyzePipeline, getBoardMetrics, searchDeals, searchContacts, listDealsByStage, listStagnantDeals, listOverdueDeals, getDealDetails, moveDeal, createDeal, updateDeal, markDealAsWon, markDealAsLost, createTask, moveDealsBulk, listActivities, completeActivity, rescheduleActivity, logActivity, addDealNote, listDealNotes, createContact, updateContact, getContactDetails, linkDealToContact, reorderStages

## Execução por etapa

| Etapa | Tool esperada | Tools chamadas | Fallback? |
| --- | --- | --- | --- |
| Listar estágios | listStages | listStages | não |
| Atualizar estágio | updateStage | listStages, updateStage | não |

## Prompts (para auditoria)

### Listar estágios

**User prompt:** Liste os estágios desse board.

**Tools chamadas:** listStages

**Preview:** Os estágios (colunas) do seu board **AI Tools Test Board Thales** são, na ordem: 1) **Novo** 2) **Proposta** 3) **Ganho** ✅ 4) **Perdido** ❌

### Atualizar estágio

**User prompt:** Atualize o label do estágio Proposta para "Proposta Enviada".

**Tools chamadas:** listStages, updateStage

**Preview:** Atualizei o estágio **Proposta**: o label agora é **“Proposta Enviada”**. ✅ Mantive o nome do estágio como **Proposta** e as demais configurações (cor e ordem) ficaram iguais.
