import { net } from "electron"

type Options = RequestInit & { bypassCustomProtocolHandlers?: boolean }

export const BEAN_FUN_HOST = "tw.beanfun.com"
export const BEAN_FUN_LOGIN_HOST = "tw.newlogin.beanfun.com"

export function beanfunFetch(url: string, options: Options = {}) {
  const defaultHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  }

  if (options?.headers)
    options.headers = { ...defaultHeaders, ...options.headers }

  return net.fetch(url, options)
}
