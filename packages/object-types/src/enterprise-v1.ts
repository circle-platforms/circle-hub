// This vocabulary is a versioned package; the storage layer assigns no meaning to its types.
export const EnterpriseTypesV1={id:'enterprise-basics',version:'1.0.0',types:[
  {id:'person',attributes:{name:'string',accounts:'object'},required:['name']},
  {id:'defect',attributes:{title:'string',state:'string',resolution:'string',assignedPerson:'string',claimedVersion:'string'},required:['title','state']},
  {id:'requirement',attributes:{title:'string',state:'string'},required:['title']},
  {id:'change',attributes:{title:'string',branch:'string',merged:'boolean'},required:['title']},
  {id:'build',attributes:{label:'string',platform:'string'},required:['label']},
  {id:'version',attributes:{label:'string',published:'boolean'},required:['label']},
  {id:'model',attributes:{label:'string'},required:['label']},
  {id:'feature',attributes:{name:'string'},required:['name']},
]};
