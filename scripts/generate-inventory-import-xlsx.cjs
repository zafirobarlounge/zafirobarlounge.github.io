const XLSX = require('xlsx');
const path = require('path');

const article = (codigo,nombre,area,unidad_base,costo_unitario_inicial=null,observaciones='') => ({codigo,nombre,area,unidad_base,existencia_inicial:null,costo_unitario_inicial,minimo:null,objetivo:null,observaciones});
const articles = [
  article('CARNE_HAMB_110','Carne hamburguesa 110 g','cocina','unidad',2000),
  article('CARNE_HAMB_150','Carne hamburguesa 150 g','cocina','unidad',2500),
  article('CARNE_MINI','Carne mini hamburguesa','cocina','unidad',800,'Referencia más reciente; existe alternativa histórica a 1.000/u.'),
  article('PAN_HAMB','Pan hamburguesa','cocina','unidad',1166.67), article('PAN_MINI','Pan mini hamburguesa','cocina','unidad',833.33),
  article('PAN_PERRO','Pan perro','cocina','unidad',1000), article('PAN_BAGUETTE','Pan baguette','cocina','unidad',2000),
  article('PAN_TAJADO','Pan tajado Bimbo','cocina','unidad',307.24,'Referencia aproximada por tajada.'),
  article('QUESO_TAJADO','Queso tajado','cocina','gramo',22.4), article('TOCINETA','Tocineta','cocina','gramo',24),
  article('HUEVO','Huevo normal','cocina','unidad',600), article('HUEVO_CODORNIZ','Huevo codorniz','cocina','unidad',233.33),
  article('TORTILLA_FAJITA','Tortilla fajita','cocina','unidad',668.75),
  article('RES_CRUDA','Pecho de res crudo','cocina','gramo',28.6,'No equivale automáticamente a carne desmechada cocida.'),
  article('POLLO_CRUDO','Pechuga campesina cruda','cocina','gramo',15.9,'No equivale automáticamente a pollo desmechado cocido.'),
  article('PAPA_PAPALISTA','Papalista','cocina','gramo',9.2), article('CREMA_LECHE','Crema de leche Parmalat','cocina','gramo',25),
  article('PARMESANO','Queso parmesano Alpina','cocina','gramo',120), article('MAIZ_CONG','Maíz congelado','cocina','gramo',10),
  article('CHORIZO_TRAD','Chorizo tradicional','cocina','unidad',3250), article('CHORIZO_BRISAS','Chorizo tradicional Las Brisas','cocina','unidad',2600),
  article('SALCH_LL','Salchicha llanera Rica','cocina','unidad',1200), article('LECHUGA','Lechuga crespa','cocina','unidad',2800,'Unidad registrada; peso aproximado histórico 180 g.'),
  article('TOMATE','Tomate chonto','cocina','gramo',null,'Costo vigente pendiente.'), article('CEBOLLA','Cebolla cabezona','cocina','gramo',3.6),
  article('PLATANO','Plátano extra','cocina','gramo',1.8), article('NACHOS','Nachos Cracho','cocina','unidad',3490,'Referencia por paquete/unidad de compra; revisar consumo parcial.'),
  article('SALSA_CHEDDAR','Salsa queso cheddar','cocina','gramo',24.95), article('SALSA_BBQ','Salsa BBQ Tomático','cocina','gramo',10),
  article('ACEITE','Aceite para fritura','cocina','mililitro',null,'Dos presentaciones confirmadas; no se asume una única vigente.'),
  article('PULPA_FRESA','Pulpa fresa','barra','unidad',1900), article('PULPA_GUANABANA','Pulpa guanábana','barra','unidad',1900),
  article('PULPA_LULO','Pulpa lulo','barra','unidad',1900), article('PULPA_MANGO','Pulpa mango','barra','unidad',1900),
  article('PULPA_ARAZA','Pulpa arazá','barra','unidad',2300), article('PULPA_MARACUYA','Pulpa maracuyá','barra','unidad',2300),
  article('PULPA_MORA','Pulpa mora','barra','unidad',2000), article('PULPA_MANDARINA','Pulpa mandarina','barra','unidad',2600),
  article('PULPA_MANGO_BICHE','Pulpa mango biche','barra','unidad',2100), article('AGUA_CRISTAL','Agua Cristal 600 ml','barra','unidad',1500),
  article('CERV_COSTENA','Cerveza Costeña','barra','unidad',2402), article('CERV_AGUILA','Cerveza Águila Original','barra','unidad',2933.33),
  article('CERV_AGUILA_LIGHT','Cerveza Águila Light','barra','unidad',3250), article('CERV_POKER','Cerveza Poker','barra','unidad',2916.67),
  article('CERV_CLUB_DORADA','Club Colombia Dorada','barra','unidad',3375), article('CERV_CORONA','Cerveza Corona','barra','unidad',null,'Costo unitario pendiente.'),
  article('COCA_400','Coca-Cola 400 ml','barra','unidad',2583.33), article('BRETANA_300','Bretaña 300 ml','barra','unidad',2500),
  article('CANADA_DRY_400','Canada Dry 400 ml','barra','unidad',2333.33), article('SMIRNOFF_ICE','Smirnoff Ice','barra','unidad',6250),
  article('AGUARDIENTE_AMARILLO','Aguardiente Amarillo botella','barra','unidad',52000,'Volumen pendiente; no se crea presentación.'),
  article('BUCHANANS_DELUXE',"Buchanan's Deluxe",'barra','unidad',165000,'Volumen pendiente; no se crea presentación.'),
  article('BUCHANANS_MASTER',"Buchanan's Master",'barra','unidad',195000,'Volumen pendiente; no se crea presentación.'),
  article('TWO_SOULS','Two Souls','barra','unidad',195000,'Volumen pendiente; no se crea presentación.'),
  article('TEQUILA_JC_REP_750','José Cuervo Especial Reposado','barra','mililitro',null,'Costo confirmado por botella de 750 ml; no se redondea un costo base inicial.'),
  article('TRIPLE_SEC','Triple sec Cóndor','barra','mililitro',null,'Costo confirmado por botella de 750 ml; no se redondea un costo base inicial.'), article('GRANADINA','Granadina Brissart','barra','mililitro',null,'Costo confirmado por botella de 1.000 ml.'),
];

const presentation = (codigo_articulo,presentacion,contenido,unidad,costo_sugerido,observaciones='') => ({codigo_articulo,presentacion,contenido,unidad,costo_sugerido,observaciones});
const presentations = [
  presentation('CARNE_HAMB_110','Paquete x10',10,'unidad',20000), presentation('CARNE_HAMB_150','Paquete x10',10,'unidad',25000),
  presentation('CARNE_MINI','Lote x20',20,'unidad',16000), presentation('CARNE_MINI','Unidad 50 g',1,'unidad',1000,'Alternativa histórica.'),
  presentation('PAN_HAMB','Paquete x6',6,'unidad',7000), presentation('PAN_MINI','Paquete x6',6,'unidad',5000), presentation('PAN_PERRO','Paquete x4',4,'unidad',4000), presentation('PAN_BAGUETTE','Paquete x4',4,'unidad',8000),
  presentation('HUEVO','Cubeta x30',30,'unidad',18000), presentation('HUEVO_CODORNIZ','Paquete x24',24,'unidad',5600), presentation('TORTILLA_FAJITA','Paquete x8',8,'unidad',5350),
  presentation('PAPA_PAPALISTA','Bolsa 2.5 kg',2500,'gramo',23000), presentation('QUESO_TAJADO','Bloque 2.5 kg',2500,'gramo',56000), presentation('TOCINETA','Bolsa 1 kg',1000,'gramo',24000),
  presentation('CREMA_LECHE','Unidad 400 g',400,'gramo',10000), presentation('PARMESANO','Unidad 100 g',100,'gramo',12000), presentation('MAIZ_CONG','Bolsa 1 kg',1000,'gramo',10000),
  presentation('CHORIZO_TRAD','Paquete x10',10,'unidad',32500), presentation('CHORIZO_BRISAS','Paquete x10',10,'unidad',26000), presentation('SALCH_LL','Paquete x16',16,'unidad',19200),
  presentation('LECHUGA','Unidad aproximada 180 g',1,'unidad',2800,'El contenido inventariable es 1 unidad; 180 g es solo referencia.'), presentation('SALSA_CHEDDAR','Envase 200 g',200,'gramo',4990),
  presentation('SALSA_BBQ','Envase 500 g',500,'gramo',5000), presentation('SALSA_BBQ','Envase 1 kg',1000,'gramo',10500,'Histórica.'), presentation('ACEITE','Envase 3 L',3000,'mililitro',23000), presentation('ACEITE','Riquísimo 5 L',5000,'mililitro',63000),
  presentation('AGUA_CRISTAL','Paca x24',24,'unidad',36000), presentation('CERV_COSTENA','Compra x48',48,'unidad',115296), presentation('CERV_AGUILA','Compra x48',48,'unidad',140800),
  presentation('CERV_AGUILA_LIGHT','Paca x24',24,'unidad',78000), presentation('CERV_AGUILA_LIGHT','Six pack x6',6,'unidad',20000,'Histórica.'), presentation('CERV_POKER','Paca x24',24,'unidad',70000), presentation('CERV_POKER','Six pack x6',6,'unidad',20000,'Histórica.'),
  presentation('CERV_CLUB_DORADA','Paca x24',24,'unidad',81000), presentation('COCA_400','Paca x12',12,'unidad',31000), presentation('BRETANA_300','Paca x24',24,'unidad',60000), presentation('CANADA_DRY_400','Paca x15',15,'unidad',35000), presentation('SMIRNOFF_ICE','Paca x24',24,'unidad',150000),
  presentation('TEQUILA_JC_REP_750','Botella 750 ml',750,'mililitro',112000), presentation('TRIPLE_SEC','Botella 750 ml',750,'mililitro',70400), presentation('GRANADINA','Botella 1 L',1000,'mililitro',32000),
  presentation('PULPA_FRESA','Unidad 130 g',1,'unidad',1900), presentation('PULPA_GUANABANA','Unidad 130 g',1,'unidad',1900), presentation('PULPA_LULO','Unidad 190 g',1,'unidad',1900), presentation('PULPA_MANGO','Unidad 130 g',1,'unidad',1900),
  presentation('PULPA_ARAZA','Unidad 110 g',1,'unidad',2300), presentation('PULPA_MARACUYA','Unidad 130 g',1,'unidad',2300), presentation('PULPA_MORA','Unidad 130 g',1,'unidad',2000), presentation('PULPA_MANDARINA','Unidad 130 g',1,'unidad',2600),
];

const recipe = (producto_menu,codigo_articulo,cantidad_base,unidad) => ({producto_menu,codigo_articulo,cantidad_base,unidad,tipo_control:'parcial'});
const menuConsumption = [
  recipe('comida::quesadilla-zafiro::1','MAIZ_CONG',30,'gramo'),recipe('comida::quesadilla-zafiro::1','TORTILLA_FAJITA',2,'unidad'),
  recipe('comida::corn-dog-zafiro-bites::2','SALCH_LL',5,'unidad'),recipe('comida::huevos-hogaos::5','HUEVO',2,'unidad'),recipe('comida::huevos-hogaos::5','PAN_TAJADO',2,'unidad'),
  recipe('comida::desgranado-el-resucitador::13','CHORIZO_TRAD',1,'unidad'),recipe('comida::desgranado-el-resucitador::13','MAIZ_CONG',40,'gramo'),recipe('comida::desgranado-el-resucitador::13','HUEVO_CODORNIZ',2,'unidad'),recipe('comida::desgranado-el-resucitador::13','PARMESANO',10,'gramo'),recipe('comida::desgranado-el-resucitador::13','PAPA_PAPALISTA',130,'gramo'),
  recipe('comida::choripan-argentino::6','CHORIZO_TRAD',1,'unidad'),recipe('comida::choripan-argentino::6','PAN_BAGUETTE',1,'unidad'),recipe('comida::choripan-argentino::6','PAPA_PAPALISTA',130,'gramo'),
  recipe('comida::perrito-loco::7','CHORIZO_BRISAS',1,'unidad'),recipe('comida::perrito-loco::7','PAN_PERRO',1,'unidad'),
  recipe('comida::hamburguesa-de-la-casa::14','PAN_HAMB',1,'unidad'),recipe('comida::hamburguesa-de-la-casa::14','CARNE_HAMB_150',1,'unidad'),
  recipe('comida::la-reina-doble::15','PAN_HAMB',1,'unidad'),recipe('comida::la-reina-doble::15','CARNE_HAMB_110',2,'unidad'),recipe('comida::la-reina-doble::15','HUEVO',1,'unidad'),
  recipe('comida::la-diabla::16','PAN_HAMB',1,'unidad'),recipe('comida::la-diabla::16','CARNE_HAMB_110',1,'unidad'),recipe('comida::la-original::17','PAN_HAMB',1,'unidad'),recipe('comida::la-original::17','CARNE_HAMB_110',1,'unidad'),
];
const juices=[['fresa','PULPA_FRESA'],['guanabana','PULPA_GUANABANA'],['lulo','PULPA_LULO'],['mango','PULPA_MANGO'],['araza','PULPA_ARAZA'],['maracuya','PULPA_MARACUYA'],['mora','PULPA_MORA']];
juices.forEach(([slug,code],index)=>{menuConsumption.push(recipe(`jugos-y-limonadas::jugo-de-${slug}-en-agua::${index+1}`,code,1,'unidad'));menuConsumption.push(recipe(`jugos-y-limonadas::jugo-de-${slug}-en-leche::${index+8}`,code,1,'unidad'));});

const pending = (articulo_relacion,dato_faltante,motivo) => ({articulo_relacion,dato_faltante,motivo});
const pendingRows = [
  pending('CARNE_DESMECHADA','Costo y rendimiento cocido','No se vincula RES_CRUDA con producto cocido sin rendimiento confiable.'), pending('POLLO_DESMECHADO','Costo y rendimiento cocido','No se vincula POLLO_CRUDO con producto cocido sin rendimiento confiable.'),
  pending('CERV_CORONA','Cantidad contenida y costo unitario confirmados','La compra histórica no confirma unidades.'), pending('TOMATE','Precio vigente','No se suministró costo confirmado.'),
  pending('QUESO_TAJADO en recetas','Conversión tajada → gramo','La unidad base es gramo y no existe peso confiable por tajada.'), pending('TOCINETA en recetas','Conversión tira → gramo','La unidad base es gramo y no existe peso confiable por tira.'),
  pending('LECHUGA/TOMATE/CEBOLLA en recetas','Conversión hoja/rodaja/cuarto → unidad base','No se inventan promedios a partir de pesos variables.'), pending('NACHOS en recetas','Contenido y conversión de medio paquete','La semántica del paquete debe confirmarse.'),
  pending('AGUARDIENTE_AMARILLO','Volumen de botella','No se crea presentación sin volumen confirmado.'), pending('BUCHANANS_DELUXE / BUCHANANS_MASTER / TWO_SOULS','Volumen de botella','No se crean presentaciones sin volumen confirmado.'),
  pending('Mini Burgers Zafiro','Clave estable real del menú','El producto no existe en el menú versionado actual; no se asocia por texto.'), pending('PULPA_MANDARINA','Producto y clave estable del jugo','No existe jugo de mandarina en el menú versionado actual.'),
  pending('PULPA_MANGO_BICHE','Receta confirmada de limonada','No se suministró que una unidad de pulpa corresponda a la limonada existente.'), pending('Relaciones restantes del menú','Conversiones explícitas en unidad base','Tajadas, tiras, hojas, rodajas, paquetes parciales, cuartos y oz quedan sin importar.'),
];

if(articles.length!==57||presentations.length!==49||menuConsumption.length!==38) throw new Error(`Conteos inesperados: ${articles.length}/${presentations.length}/${menuConsumption.length}`);
const workbook=XLSX.utils.book_new();
for(const [name,rows] of [['Articulos',articles],['Presentaciones',presentations],['ConsumoMenu',menuConsumption],['Pendientes',pendingRows]]){
  const sheet=XLSX.utils.json_to_sheet(rows,{skipHeader:false}); sheet['!cols']=Object.keys(rows[0]).map((header)=>({wch:Math.max(header.length+2,24)})); XLSX.utils.book_append_sheet(workbook,sheet,name);
}
XLSX.writeFile(workbook,path.join(__dirname,'..','data','zafiro-inventory-initial.xlsx'),{compression:true});
console.log(JSON.stringify({articles:articles.length,presentations:presentations.length,menuAssociations:menuConsumption.length,pending:pendingRows.length}));
