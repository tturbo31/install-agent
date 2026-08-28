import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  {
    file: "ROTAS.md",
    find: `a mesma lista + nota interna **ROUTE PRIORITY** (quando o ZIP/cidade do cliente já é conhecido): marca o **dia prioritário** (o mais próximo ainda abaixo da meta de ocupação) e ordena os horários de cada dia (buracos primeiro, depois melhor rota). O modelo continua oferecendo **a mesma quantidade** de opções (2), tiradas do dia prioritário. |`,
    replace: `a mesma lista + nota interna **ROUTE PRIORITY** (quando o ZIP/cidade do cliente já é conhecido): marca o **dia prioritário** (o mais próximo com QUALQUER vaga) e lista os horários de cada dia **em ordem do relógio** — regra do dono 28/08: os PRIMEIROS horários primeiro, para não deixar buraco. O modelo continua oferecendo **a mesma quantidade** de opções (2), tiradas do dia prioritário. A rota **não** reordena a oferta; ela só escolhe o vendedor no \`[BOOK]\`. |`,
  },
  {
    file: "ROTAS.md",
    find: `| Mensagens enlatadas de recuperação (\`needTimeChoiceMessage\`, \`slotConflictRecoveryMessage\`) | primeiros N horários do dia | os N de melhor rota (mesma quantidade), apresentados em ordem cronológica. |`,
    replace: `| Mensagens enlatadas de recuperação (\`needTimeChoiceMessage\`, \`slotConflictRecoveryMessage\`) | primeiros N horários do dia | os N PRIMEIROS horários do dia (com \`ROUTE_EARLIEST_FIRST=1\`, o padrão); com a flag em \`0\`, os N de melhor rota. Em ambos os casos em ordem cronológica e respeitando os 120 min de antecedência de hoje. |`,
  },
  {
    file: "ROTAS.md",
    find: `Na oferta, os horários em que ele está livre vêm primeiro no dia; no \`[BOOK]\`, ele é escolhido sempre que está livre e a rota é viável`,
    replace: `Desde 28/08 isto vale SÓ no \`[BOOK]\` (a oferta é sempre cronológica): ele é escolhido sempre que está livre e a rota é viável`,
  },
  {
    file: "ROTAS.md",
    find: `| \`ROUTE_FILL_FIRST\` | \`1\` | data primeiro: dia prioritário = primeiro dia com vaga abaixo da meta |
| \`ROUTE_TARGET_NEXT_DAY_FILL_RATE\` | \`0.9\` | meta de ocupação do dia prioritário (0–1) |`,
    replace: `| \`ROUTE_FILL_FIRST\` | \`1\` | data primeiro: dia prioritário = primeiro dia com vaga abaixo da meta |
| \`ROUTE_TARGET_NEXT_DAY_FILL_RATE\` | \`1\` | meta de ocupação do dia prioritário (0–1). **1 = qualquer vaga no dia mais próximo o torna prioritário** (regra do dono 28/08: nenhum horário vago fica para trás) |
| \`ROUTE_EARLIEST_FIRST\` | \`1\` | dentro do dia, os **primeiros horários** vêm primeiro (ordem do relógio) e a rota só escolhe o vendedor no \`[BOOK]\`. \`0\` = ordem por rota (comportamento de 27/08) |`,
  },
]);
