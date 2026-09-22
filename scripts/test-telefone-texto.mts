// TEXTO NÃO É TELEFONE — teste puro da régua que o agente aplica antes de
// mandar `telefone` à plataforma (22/09/2026). Caso real: "Jesus, 3285 Nw
// 211th St, Miami Gardens, 33056" tem 12 dígitos e virou a identidade do lead.
//   node ./node_modules/tsx/dist/cli.mjs scripts/test-telefone-texto.mts
import { pareceTelefone } from "../src/lib/telefone-texto";

let ok = 0;
let falhas = 0;
const checar = (nome: string, cond: boolean) => {
  if (cond) ok++;
  else falhas++;
  console.log(`  [${cond ? "OK" : "FALHOU"}] ${nome}`);
};

// texto que NÃO pode virar telefone
for (const t of [
  "Jesus, 3285 Nw 211th St, Miami Gardens, 33056",
  "Theresa Warren 3349 Perimeter Drive, Greenacres 33467",
  "Hi, I want new floors for 1000 sq ft, budget 2350",
  "13341 NW 11th St, Pembroke Pines, FL, 33028, USA",
  "wefwefwe 234234234234",
]) checar(`texto barrado: ${t.slice(0, 40)}`, !pareceTelefone(t));

// número de verdade continua passando
for (const t of ["7869758018", "+17869758018", "(786) 975-8018", "786-975-8018", "1 786 975 8018", "+972541234567", "5616545931 ext 12", "561-654-5931 x4"])
  checar(`número aceito: ${t}`, pareceTelefone(t));

// curto demais / zeros continuam fora
for (const t of ["12345", "0000000000", "", null, undefined]) checar(`fora: ${String(t)}`, !pareceTelefone(t));

console.log(`\n${ok} ok · ${falhas} falha(s)`);
process.exit(falhas > 0 ? 1 : 0);
