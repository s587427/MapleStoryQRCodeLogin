import {
  IPC_STORE_GET,
  IPC_STORE_SET,
  IPC_SYSTEM_AUTO_LOGIN,
  IPC_SYSTEM_OPEN_EXTERNAL,
  VK,
} from "@/const"
import { clipboard, ipcMain, shell } from "electron"
import Store from "electron-store"
import { win } from "../utils/koffi"

const store = new Store()

ipcMain.handle(IPC_STORE_GET, async (event, key: string) => {
  return store.get(key)
})
ipcMain.handle(IPC_STORE_SET, async (event, key: string, value: unknown) => {
  store.set(key, value)
})

ipcMain.handle(IPC_SYSTEM_OPEN_EXTERNAL, (event, url: string) =>
  shell.openExternal(url)
)

ipcMain.on(
  IPC_SYSTEM_AUTO_LOGIN,
  async (event, account: string, password: string) => {
    const hwnd = win.findWindow("MapleStory")
    if (hwnd) {
      console.log("found hwnd: ", hwnd)
      win.showWindow(hwnd)
      win.setForegroundWindow(hwnd)

      await new Promise((resolve) => setTimeout(resolve, 200))

      clipboard.writeText(account)
      await win.pressKeys([VK.CONTROL, VK.A])
      await win.pressKeys([VK.BACK])
      await win.pressKeys([VK.CONTROL, VK.V])
      await win.pressKeys([VK.TAB])

      clipboard.writeText(password)
      await win.pressKeys([VK.CONTROL, VK.V])
      await win.pressKeys([VK.Enter])
    } else {
      console.log("not found hwnd: ", hwnd)
    }
  }
)
