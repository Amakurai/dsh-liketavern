/** 完整 Faker namespace 在 QuickJS 中惰性装入；全语言数据、官方 API、随机种子与参考日期均留在沙箱内。 */
export const TEMPLATE_FAKER = String.raw `
(()=>{
  let source=globalThis.__tavernFakerSource;
  globalThis.__resetTemplateFaker=()=>{};
  delete globalThis.__tavernFakerSource;
  function lazyFakerProperty(target,name,load) {
    Object.defineProperty(target,name,{enumerable:true,configurable:true,get(){
      const value=load(); Object.defineProperty(target,name,{enumerable:true,configurable:true,writable:true,value}); return value;
    }});
  }
  lazyFakerProperty(api,'faker',()=>{
    if(typeof source!=='string') throw Error('Faker 依赖产物缺失，请先运行 npm run build');
    const fakerLibrary=new Function(source+';\nreturn __TavernFakerLibraries;')();
    source=undefined;
    const fakerNamespace=Object.assign(Object.create(null),fakerLibrary.fakerCore);
    const fakerLocales=Object.create(null),fakerInstances=Object.create(null),loadedInstances=[];
    for(const code of Object.keys(fakerLibrary.fakerLocaleJson)) {
      lazyFakerProperty(fakerLocales,code,()=>JSON.parse(fakerLibrary.fakerLocaleJson[code]));
      lazyFakerProperty(fakerNamespace,code,()=>fakerLocales[code]);
      lazyFakerProperty(fakerInstances,code,()=>{
        // 直接传入已设种子的官方随机源，避免默认源先随机初始化后再次 seed。
        const instance=new fakerNamespace.Faker({locale:fakerLibrary.fakerFallbacks[code].map(key=>fakerLocales[key]),randomizer:fakerLibrary.fakerCore.generateMersenne53Randomizer(input.seed>>>0)});
        instance.setDefaultRefDate(input.now); loadedInstances.push(instance); return instance;
      });
    }
    for(const [name,code] of Object.entries(fakerLibrary.fakerInstanceNames)) lazyFakerProperty(fakerNamespace,name,()=>fakerInstances[code]);
    fakerNamespace.allLocales=fakerLocales;
    fakerNamespace.allFakers=fakerInstances;
    fakerNamespace.simpleFaker.seed(input.seed>>>0);
    fakerNamespace.simpleFaker.setDefaultRefDate(input.now);
    globalThis.__resetTemplateFaker=()=> {
      for(const instance of [fakerNamespace.simpleFaker,...loadedInstances]) {instance.seed(input.seed>>>0);instance.setDefaultRefDate(input.now);}
    };
    return fakerNamespace;
  });
})();
`;
