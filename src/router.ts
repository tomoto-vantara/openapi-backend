import * as _ from 'lodash';
import { OpenAPIV3 } from 'openapi-types';
import bath from 'bath-es5';
import * as cookie from 'cookie';
import { parse as parseQuery } from 'qs';
import { Parameters } from 'bath-es5/_/types';

// alias Document to OpenAPIV3.Document
type Document = OpenAPIV3.Document;

/**
 * OAS Operation Object containing the path and method so it can be placed in a flat array of operations
 *
 * @export
 * @interface Operation
 * @extends {OpenAPIV3.OperationObject}
 */
export interface Operation extends OpenAPIV3.OperationObject {
  path: string;
  method: string;
}

export interface Request {
  method: string;
  path: string;
  headers: {
    [key: string]: string | string[];
  };
  query?:
    | {
        [key: string]: string | string[];
      }
    | string;
  body?: any;
}

export interface ParsedRequest extends Request {
  params: {
    [key: string]: string | string[];
  };
  cookies: {
    [key: string]: string | string[];
  };
  query: {
    [key: string]: string | string[];
  };
  requestBody: any;
}

/**
 * Class that handles routing
 *
 * @export
 * @class OpenAPIRouter
 */
export class OpenAPIRouter {
  public definition: Document;
  public apiRoot: string;

  /**
   * Creates an instance of OpenAPIRouter
   *
   * @param opts - constructor options
   * @param {Document} opts.definition - the OpenAPI definition, file path or Document object
   * @param {string} opts.apiRoot - the root URI of the api. all paths are matched relative to apiRoot
   * @memberof OpenAPIRouter
   */
  constructor(opts: { definition: Document; apiRoot?: string }) {
    this.definition = opts.definition;
    this.apiRoot = opts.apiRoot || '/';
  }

  /**
   * Matches a request to an API operation (router)
   *
   * @param {Request} req
   * @param {boolean} [strict] strict mode, throw error if operation is not found
   * @returns {Operation }
   * @memberof OpenAPIRouter
   */
  public matchOperation(req: Request): Operation | undefined;
  public matchOperation(req: Request, strict: boolean): Operation;
  public matchOperation(req: Request, strict?: boolean) {
    // normalize request for matching
    req = this.normalizeRequest(req);

    // if request doesn't match apiRoot, throw 404
    if (!req.path.startsWith(this.apiRoot)) {
      if (strict) {
        throw Error('404-notFound: no route matches request');
      } else {
        return undefined;
      }
    }

    // get relative path
    const normalizedPath = this.normalizePath(req.path);

    // get all operations matching exact path
    const exactPathMatches = _.filter(this.getOperations(), ({ path }) => path === normalizedPath);

    // check if there's one with correct method and return if found
    const exactMatch = _.find(exactPathMatches, ({ method }) => method === req.method);
    if (exactMatch) {
      return exactMatch;
    }

    // check with path templates
    const templatePathMatches = _.filter(this.getOperations(), ({ path }) => {
      // convert openapi path template to a regex pattern i.e. /{id}/ becomes /[^/]+/
      const pathPattern = `^${path.replace(/\{.*?\}/g, '[^/]+')}$`;
      return Boolean(normalizedPath.match(new RegExp(pathPattern, 'g')));
    });

    // if no operations match the path, throw 404
    if (!templatePathMatches.length) {
      if (strict) {
        throw Error('404-notFound: no route matches request');
      } else {
        return undefined;
      }
    }

    // find matching operation
    const match = _.chain(templatePathMatches)
      // order matches by length (specificity)
      .orderBy((op) => op.path.replace(RegExp(/\{.*?\}/g), '').length, 'desc')
      // then check if one of the matched operations matches the method
      .find(({ method }) => method === req.method)
      .value();

    if (!match) {
      if (strict) {
        throw Error('405-methodNotAllowed: this method is not registered for the route');
      } else {
        return undefined;
      }
    }

    return match;
  }

  /**
   * Flattens operations into a simple array of Operation objects easy to work with
   *
   * @returns {Operation[]}
   * @memberof OpenAPIRouter
   */
  public getOperations(): Operation[] {
    const paths = _.get(this.definition, 'paths', {});
    return _.chain(paths)
      .entries()
      .flatMap(([path, pathBaseObject]) => {
        const methods = _.pick(pathBaseObject, ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
        return _.entries(methods).map(([method, operation]) => {
          const op = operation as OpenAPIV3.OperationObject;
          return {
            ...op,
            path,
            method,
            // append the path base object's parameters to the operation's parameters
            parameters: [
              ...((op.parameters as OpenAPIV3.ParameterObject[]) || []),
              ...((pathBaseObject.parameters as OpenAPIV3.ParameterObject[]) || []), // path base object parameters
            ],
            // operation-specific security requirement override global requirements
            security: op.security || this.definition.security || [],
          };
        });
      })
      .value();
  }

  /**
   * Gets a single operation based on operationId
   *
   * @param {string} operationId
   * @returns {Operation}
   * @memberof OpenAPIRouter
   */
  public getOperation(operationId: string): Operation | undefined {
    return _.find(this.getOperations(), { operationId });
  }

  /**
   * Normalises request:
   * - http method to lowercase
   * - path leading slash 👍
   * - path trailing slash 👎
   * - path query string 👎
   *
   * @export
   * @param {Request} req
   * @returns {Request}
   */
  public normalizeRequest(req: Request): Request {
    return {
      ...req,
      path: (req.path || '')
        .trim()
        .split('?')[0] // remove query string
        .replace(/\/+$/, '') // remove trailing slash
        .replace(/^\/*/, '/'), // add leading slash
      method: req.method.trim().toLowerCase(),
    };
  }

  /**
   * Normalises path for matching: strips apiRoot prefix from the path.
   *
   * @export
   * @param {string} path
   * @returns {string}
   */
  public normalizePath(path: string) {
    return path.replace(new RegExp(`^${this.apiRoot}/?`), '/');
  }

  /**
   * Parses and normalizes a request
   * - parse json body
   * - parse query string
   * - parse cookies from headers
   * - parse path params based on uri template
   *
   * @export
   * @param {Request} req
   * @param {string} [patbh]
   * @returns {ParsedRequest}
   */
  public parseRequest(req: Request, operation?: Operation): ParsedRequest {
    let requestBody = req.body;
    if (req.body && typeof req.body !== 'object') {
      try {
        // attempt to parse json
        requestBody = JSON.parse(req.body.toString());
      } catch {
        // suppress json parsing errors
        // we will emit error if validation requires it later
      }
    }

    // header keys are converted to lowercase, so Content-Type becomes content-type
    const headers = _.mapKeys(req.headers, (val, header) => header.toLowerCase());

    // parse cookie from headers
    const cookieHeader = headers['cookie'];
    const cookies = cookie.parse(_.flatten([cookieHeader]).join('; '));

    // get query string from path
    const queryString = req.path.split('?')[1];
    const query = typeof req.query === 'object' ? req.query : parseQuery(queryString);

    // normalize
    req = this.normalizeRequest(req);

    let params: Parameters = {};
    if (operation) {
      // get relative path
      const normalizedPath = this.normalizePath(req.path);

      // parse path params if path is given
      const pathParams = bath(operation.path);
      params = pathParams.params(normalizedPath) || {};

      // parse query parameters with specified style for parameter
      if (typeof req.query !== 'object' && queryString) {
        for (const queryParam in query) {
          if (query[queryParam]) {
            const parameter = _.find((operation.parameters as OpenAPIV3.ParameterObject[]) || [], {
              name: queryParam,
              in: 'query',
            });
            if (parameter && parameter.explode === false) {
              let commaQueryString = queryString;
              if (parameter.style === 'spaceDelimited') {
                commaQueryString = commaQueryString.replace(/\ /g, ',').replace(/\%20/g, ',');
              }
              if (parameter.style === 'pipeDelimited') {
                commaQueryString = commaQueryString.replace(/\|/g, ',').replace(/\%7C/g, ',');
              }
              // use comma parsing e.g. &a=1,2,3
              const commaParsed = parseQuery(commaQueryString, { comma: true });
              query[queryParam] = commaParsed[queryParam];
            }
          }
        }
      }

      // ensure the array parameters are split to array even if they are passed in an object form
      ((operation.parameters as OpenAPIV3.ParameterObject[]) || [])
        // get unexploded array type parameters in query
        .filter((p) => p.explode === false && p.in === 'query')
        // the parameter actually exists and not yet split
        .filter((p) => _.isString(query[p.name]))
        .forEach((p) => {
          // split by the delimiter specified by the style
          const d = p.style === 'spaceDelimited' ? ' ' : p.style === 'pipeDelimited' ? '|' : ',';
          query[p.name] = query[p.name].split(d);
        });
    }

    return {
      ...req,
      params,
      headers,
      query,
      cookies,
      requestBody,
    };
  }
}
