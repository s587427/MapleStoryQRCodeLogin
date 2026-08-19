export type IpcResponse<T = any> = {
  error?: boolean
  message: string
  data?: T
}

export interface GetInitLoginResponse {
  ResultData: {
    QRImage: string
    IsHK: boolean
    IsRecaptcha: boolean
    RecaptchaV2PublicKey: string
    IsOTP: boolean
    DeepLink: string
  }
  Result: number
  __APICheckFlag: string
  APIVersion: string
  ErrorSeqNum: number
  StatusCode: number
  ResultCode: number
  ResultMessageCode: number
  LogMessage: string
  ResultMessage: string
}

export interface OtpV2Response {
  result: 0 | 1
  data: string
  message: null | string
}
