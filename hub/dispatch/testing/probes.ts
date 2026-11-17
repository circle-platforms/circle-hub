// Deployment-only synthetic probe declarations.
export const probes = {devices:'/devices',command_pattern:'^inspect (?:version|interfaces)$',call:{tool:'inspect_seat',arguments:{seat:{$value:'seat_index'},command:{$value:'command'},ticket:{$value:'lease_id'}}},output:'/output',seats:[0,1].map(index=>({seat:`synthetic-${index}`,index,manifest:{device:`/devices/${index}`,addresses:'/interfaces',address:'/address'},version:{command:'inspect version',pattern:'^version: (?<value>.+)$'},interfaces:{command:'inspect interfaces',pattern:'^address: (?<value>.+)$'}}))};

export const residue = [
  {command:'inspect peers',closing:'DEMO#',header_patterns:['peers:','name\\s+address'],failure_patterns:['% rejected.*']},
  {command:'inspect units',closing:'DEMO#'},
];
export const probesWithResidue = {...probes,command_pattern:'^inspect (?:version|interfaces|peers|units)$',seats:probes.seats.map(seat=>({...seat,residue}))};
