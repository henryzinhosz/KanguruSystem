// Codigo de produto/servico: so letras, numeros e hifen, em maiusculas, ate 30
// caracteres (mesma regra do banco). O leitor de codigo de barras digita igual
// em qualquer teclado do Windows.
export const sanitizeItemCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
