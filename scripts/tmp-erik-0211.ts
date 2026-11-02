process.env.ANTHROPIC_API_KEY ||= "x";
import { isPureClosing } from "../src/lib/ai";
const yes=["Send me your info, thanks","Thanks, send me the prices","Can you send me more info? thanks","Mándame información gracias","Me manda o orçamento, obrigado","Your website please, thank you","More info please"];
const no=["Thanks!","Ok thank you","Thank you, I will let you know","Gracias, te aviso","Obrigado, tchau","Bye","Take care, thanks for the info"];
for(const t of yes)console.log(isPureClosing(t)?"FAIL (closing)":"ok (request)",JSON.stringify(t));
for(const t of no)console.log(isPureClosing(t)?"ok (closing)":"FAIL (not closing)",JSON.stringify(t));
