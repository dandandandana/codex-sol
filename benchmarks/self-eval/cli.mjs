import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { prepareRun, gradeRun, compareReports, calibrate } from './runner.mjs';

const usage = 'Usage: node benchmarks/self-eval/cli.mjs prepare --out <new-dir> [--case T01] | grade --run <dir> --out <new-report-dir> [--label <label>] | compare --a <report.json> --b <report.json> --out <new-dir> | calibrate --out <new-dir>';
async function main(argv) {
  if(argv.length===1 && ['--help','-h'].includes(argv[0])) { process.stdout.write(usage+'\n'); return; }
  const [command,...args]=argv, definitions={prepare:['out','case'],grade:['run','out','label'],compare:['a','b','out'],calibrate:['out']};
  if(!Object.hasOwn(definitions,command) || args.length%2!==0) throw new Error(usage);
  const options={};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i].slice(2); if(!args[i].startsWith('--') || !definitions[command].includes(key) || Object.hasOwn(options,key) || !args[i+1] || args[i+1].startsWith('--')) throw new Error(usage);
    options[key]=args[i+1];
  }
  const required={prepare:['out'],grade:['run','out'],compare:['a','b','out'],calibrate:['out']}[command];
  if(required.some(key=>!options[key])) throw new Error(usage);
  const result=await ({prepare:()=>prepareRun({out:options.out,caseId:options.case}),grade:()=>gradeRun(options),compare:()=>compareReports(options),calibrate:()=>calibrate(options)})[command]();
  process.stdout.write(JSON.stringify({status:'completed',command,out:result.out,...(result.report?{metrics:result.report.metrics}:{}),...(command==='calibrate'?{calibration_status:result.status,not_a_model_eval:true}:{})})+'\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error=>{process.stderr.write('Self-eval failed: '+error.message+'\n');process.exitCode=1;});
