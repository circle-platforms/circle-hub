import ExcelJS from 'exceljs';

export async function executionWorkbook(options:{command?:string;method?:string;hidden?:boolean;sheet?:string;extraSheet?:boolean;object?:string;extraDevice?:{index:number;command:string};inputVariables?:string;hostCommand?:{host:string;command:string;saveAs?:string;inputRegister?:string}}={}):Promise<Buffer>{
  const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet(options.sheet??'执行');
  sheet.addRow(['APV_EXCEL_CONTRACT | apv.excel.runtime | v1']).hidden=options.hidden??true;
  sheet.addRow(['自动化ID','优先级','语句类型','描述','测试对象','方法','数据','临时保存期望结果','输入变量']);
  sheet.addRow(['301','P1',2,'Inspect synthetic status',options.object??'APV_0',options.method??'cmd_config',options.command??'service inspect alpha','',options.inputVariables??'']);
  if(options.extraDevice)sheet.addRow(['','',3,'Inspect another synthetic device',`APV_${options.extraDevice.index}`,'cmd_config',options.extraDevice.command,'','']);
  if(options.hostCommand)sheet.addRow(['','',3,'Synthetic traffic request','test_env',options.hostCommand.host,options.hostCommand.command,options.hostCommand.saveAs??'',options.hostCommand.inputRegister??'']);
  sheet.addRow(['','',3,'Required output','check_point','found','healthy']);
  sheet.addRow(['','',4,'Forbidden output','check_point','not_found','panic']);
  sheet.addRow(['999999999999999','P9',2,'End sentinel','time','sleep',1]);
  if(options.extraSheet)workbook.addWorksheet('Other');return Buffer.from(await workbook.xlsx.writeBuffer());
}
