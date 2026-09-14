/** Selected fictional views, not authentication or a guest portal. No mutations. */
const clone = value => JSON.parse(JSON.stringify(value));
export function createDemoFamily(records, {now = () => new Date().toISOString(), fail = message => { throw new Error(message); }} = {}) {
  const capturedAt = now();
  const date = capturedAt.slice(0, 10);
  const members = [{id:'alex', name:'Alex Row', role:'owner', status:'active'},
    {id:'jamie', name:'Jamie Row', role:'parent', status:'active'},
    {id:'sam', name:'Sam Lee', role:'collaborator', status:'active'}];
  const child = {id:'leo', name:'Leo', guardianIds:['alex','jamie'], notes:'School dates, activities and family plans.'};
  const task = records['/api/state'].items.find(item => item.headline.includes('Northstar'));
  const plan = records['/api/health-tracking'].plans[0];
  const common = {createdAt:capturedAt, updatedAt:capturedAt, version:1, ownerId:'alex', status:'open'};
  const shared = [
    {...common, id:'family_school', kind:'task', title:'Pack the school-trip kit', details:'Water bottle, rain jacket and the signed permission slip.',
      date, visibility:'family', subjectId:child.id, assigneeId:'jamie'},
    {...common, id:'family_meal_snapshot', kind:'plan', title:plan.title, details:plan.entries.map(entry => `${entry.title} — ${entry.details}`).join('\n'),
      date:plan.weekStart, visibility:'family', subjectId:'', source:{kind:'health_plan', id:plan.id, label:'Health · saved meal and activity plan', capturedAt}},
    {...common, id:'family_task_snapshot', kind:'task', title:task.headline, details:task.why, date, visibility:'private', subjectId:'', assigneeId:'alex',
      source:{kind:'item', id:task.id, label:'Today · selected task', capturedAt}},
    {...common, id:'family_alex_private', kind:'note', title:'Alex’s private reflection', details:'Make room for a quiet morning before the next project starts.', date, visibility:'private', subjectId:''},
    {...common, id:'family_jamie_private', ownerId:'jamie', kind:'note', title:'Jamie’s private weekend idea', details:'A personal note saved to Jamie’s account.', date, visibility:'private', subjectId:''},
  ];
  const grant = {id:'sample_access', grantorId:'alex', grantorName:'Alex Row', accountId:'sam', label:'Northstar presentation review',
    recordIds:['family_task_snapshot'], subjectIds:[], kinds:['task'], includeFuture:false,
    permissions:{view:true, submitTasks:false, uploadDocuments:false, directTasks:false},
    createdAt:capturedAt, expiresAt:new Date(Date.parse(capturedAt) + 30 * 86400000).toISOString(), revokedAt:null};
  return (person = 'alex') => {
    const me = members.find(member => member.id === person);
    if (!me) return fail('Choose one of the fictional people in this demo.', 404);
    const collaborator = me.role === 'collaborator';
    const visible = shared.filter(record => collaborator ? grant.recordIds.includes(record.id)
      : record.ownerId === me.id || record.visibility === 'family' && (!record.subjectId || child.guardianIds.includes(me.id)));
    return clone({family:{id:'demo_family', name:'The Row family'}, me, records:visible,
      members:collaborator ? members.filter(member => ['alex','sam'].includes(member.id)) : members.filter(member => member.role !== 'collaborator' || me.id === 'alex'),
      children:collaborator ? [] : [child], grants:['alex','sam'].includes(me.id) ? [grant] : [],
      submissions:[], activity:[], invitations:[], credentials:[], portal:{ready:false, published:false, url:''},
      permissions:{view:true, manage:false}, demo:{readOnly:true, people:members, capturedAt}});
  };
}
