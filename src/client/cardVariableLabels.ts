/** 卡面、后台脚本和预览共用变量工具文案，新增编辑器状态在中英文界面保持一致。 */
import type {CardVariableLabels} from '../core/cardVariables.js'
export function cardVariableLabels(t:(key:string)=>string,note:string):Required<CardVariableLabels>{
  return{
    title:t('speech.cardDataTitle'),note,backup:t('speech.cardDataBackup'),text:t('speech.cardDataText'),
    editor:t('speech.variableEditor'),scope:t('speech.variableScope'),messageId:t('speech.variableMessageId'),
    editorText:t('speech.variableEditorText'),load:t('speech.variableLoad'),validate:t('speech.variableValidate'),
    save:t('speech.variableSave'),discard:t('speech.variableDiscard'),valid:t('speech.variableValid'),
    saved:t('speech.variableSaved'),localSaved:t('speech.variableLocalSaved'),saving:t('speech.variableSaving'),
    unsaved:t('speech.variableUnsaved'),conflict:t('speech.variableConflict'),failed:t('speech.variableFailed'),
    timeout:t('speech.variableTimeout'),scopeGlobal:t('speech.variableScopeGlobal'),scopePreset:t('speech.variableScopePreset'),
    scopeCharacter:t('speech.variableScopeCharacter'),scopeChat:t('speech.variableScopeChat'),scopeMessage:t('speech.variableScopeMessage'),
  }
}
