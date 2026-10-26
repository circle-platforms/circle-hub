// Types only for the adjacent JSON data module; the repository does not enable resolveJsonModule.
declare const labels: {
  dispositions: Array<{code:string;label:string;display:string}>;
  ranks: Array<{code:string;label:string}>;
  probes: Array<{code:string;label:string}>;
  finalRanks: Array<{code:string;label:string}>;
  finalCodes: Array<{code:string;label:string}>;
  hubCodes: Array<{code:string;label:string}>;
};
export default labels;
