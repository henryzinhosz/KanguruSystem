// Impressao direta (2.8c): envia bytes ESC/POS "crus" para a impressora instalada no Windows,
// pelo nome, sem passar pela janela de impressao. Funciona com termicas que aceitam ESC/POS
// (Epson TM-T20 e a maioria das outras).

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_4W,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }

    pub fn list() -> Result<Vec<String>, String> {
        unsafe {
            let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
            let mut needed = 0u32;
            let mut returned = 0u32;
            EnumPrintersW(flags, std::ptr::null(), 4, std::ptr::null_mut(), 0, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new());
            }
            let mut buffer = vec![0u8; needed as usize];
            if EnumPrintersW(flags, std::ptr::null(), 4, buffer.as_mut_ptr(), needed, &mut needed, &mut returned) == 0 {
                return Err("Não foi possível listar as impressoras do Windows.".into());
            }
            let infos = std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_4W, returned as usize);
            Ok(infos.iter().map(|info| from_wide(info.pPrinterName)).collect())
        }
    }

    pub fn print(printer: &str, data: &[u8]) -> Result<(), String> {
        unsafe {
            let name = wide(printer);
            let mut handle = PRINTER_HANDLE { Value: std::ptr::null_mut() };
            if OpenPrinterW(name.as_ptr(), &mut handle, std::ptr::null()) == 0 {
                return Err(format!("Impressora \"{printer}\" não encontrada."));
            }
            let mut doc_name = wide("Kanguru PDV");
            let mut datatype = wide("RAW");
            let doc = DOC_INFO_1W {
                pDocName: doc_name.as_mut_ptr(),
                pOutputFile: std::ptr::null_mut(),
                pDatatype: datatype.as_mut_ptr(),
            };
            if StartDocPrinterW(handle, 1, &doc) == 0 {
                ClosePrinter(handle);
                return Err("A impressora recusou o trabalho de impressão.".into());
            }
            StartPagePrinter(handle);
            let mut written = 0u32;
            let ok = WritePrinter(handle, data.as_ptr() as *const c_void, data.len() as u32, &mut written);
            EndPagePrinter(handle);
            EndDocPrinter(handle);
            ClosePrinter(handle);
            if ok == 0 || written as usize != data.len() {
                return Err("Falha ao enviar os dados para a impressora.".into());
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn list() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    pub fn print(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("Impressão direta disponível só no Windows.".into())
    }
}

#[tauri::command]
pub fn list_printers() -> Result<Vec<String>, String> {
    imp::list()
}

#[tauri::command]
pub fn print_raw(printer: String, data: Vec<u8>) -> Result<(), String> {
    imp::print(&printer, &data)
}
