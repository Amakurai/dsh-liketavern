/** 沙箱内 schema 注册与原子校验；Zod 与用户校验函数均在 QuickJS 内运行，不调用 Node 回调。 */
export const TEMPLATE_SCHEMA = String.raw `
const z = __TavernTemplateLibraries.z;
let variableSchema = null;
let validatingSchema = false;
let schemaState = serializeTemplateJson(scopes);
let schemaCacheState = serializeTemplateJson(variables);
function rememberSchemaState() { schemaState=serializeTemplateJson(scopes);schemaCacheState=serializeTemplateJson(variables); }
function setVariableSchema(schema) {
  assertNotConditionReadonly('修改变量 schema');
  if (validatingSchema) throw Error('变量校验期间不能替换 schema');
  if (schema instanceof z.ZodType) variableSchema = typeof schema.loose==='function' ? schema.loose() : schema;
  else if (schema && typeof schema==='object' && !Array.isArray(schema)) variableSchema = z.looseObject(schema);
  else throw Error('变量 schema 必须是 Zod schema 或字段 schema 对象');
  rememberSchemaState();
}
function checkVariableSchema(value) {
  const inputJson = serializeTemplateJson(value);
  if (!variableSchema) return parseTemplateInput(inputJson);
  if (validatingSchema) throw Error('变量校验期间不能修改变量');
  const originalVariables=clone(variables), originalScopes=clone(scopes), originalInitial=clone(initial),originalMessages=clone(messageSnapshots);
  const previous=serializeTemplateJson({variables,scopes,initial,messageSnapshots});
  validatingSchema=true;
  try {
    const result=variableSchema.parse(parseTemplateInput(inputJson));
    if (serializeTemplateJson({variables,scopes,initial,messageSnapshots})!==previous) throw Error('schema 校验函数不能修改变量');
    if (!result || typeof result!=='object' || Array.isArray(result)) throw Error('变量 schema 根输出必须是对象');
    return parseTemplateInput(serializeTemplateJson(result));
  } finally {
    // 用户 validator 即使抛错、产生循环引用或经引用写入，也不得跳过回滚或锁死 validatingSchema。
    // 纯校验保留引用身份；否则 findVariables 返回的当前树会和 scopes.message 失联。
    try {
      let mutated=false;
      try { mutated=serializeTemplateJson({variables,scopes,initial,messageSnapshots})!==previous; }
      catch { mutated=true; }
      if(mutated) {
        for (const key of Object.keys(scopes)) delete scopes[key];
        Object.assign(scopes,originalScopes);
        for (const key of Object.keys(initial)) delete initial[key];
        Object.assign(initial,originalInitial);
        messageSnapshots=originalMessages;
        if(currentMessageIndex>=0) scopes.message=snapshotAt(currentMessageIndex).values;
        variables=originalVariables; api.variables=variables;
      }
    } finally {
      validatingSchema=false;
    }
  }
}
function copySchemaChanges(target,before,after,parts=[]) {
  for (const key of new Set([...Object.keys(before),...Object.keys(after)])) {
    const next=[...parts,key];
    if (!Object.hasOwn(after,key)) {
      const parent=parts.length ? get(target,parts) : target;
      if (parent && typeof parent==='object') delete parent[key];
    } else if (!equal(before[key],after[key])) {
      const left=before[key],right=after[key];
      if (left && right && typeof left==='object' && typeof right==='object' && !Array.isArray(left) && !Array.isArray(right)) copySchemaChanges(target,left,right,next);
      else set(target,next,right);
    }
  }
}
Object.assign(api,{z,setVariableSchema,_:__TavernTemplateLibraries.lodash,
  parseJSON:text=>parseTemplateInput(__TavernTemplateLibraries.jsonrepair(String(text)))});
`;
