/**
 * 业务规则错误。statusCode 给出建议的 HTTP 状态，details 承载冲突现场数据，
 * 便于金融机构把冲突响应接入自身风控流程。
 */
export class DomainError extends Error {
  constructor(code, message, statusCode = 409, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
