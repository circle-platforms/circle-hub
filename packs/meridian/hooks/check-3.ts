export default function handle(input:any){return input.subject?.deny===true?{decision:'block',code:'FIXTURE_BLOCKED',facts:{event:input.event}}:{decision:'pass'};}
