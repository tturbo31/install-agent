// SÓ LEITURA (26/10/2026): a agenda exatamente como o modelo recebe agora (getRealAvailabilityContext).
import { getRealAvailabilityContext, getEasternDateContext } from "../src/lib/scheduler";
console.log(getEasternDateContext());
const txt = await getRealAvailabilityContext();
console.log(txt);
