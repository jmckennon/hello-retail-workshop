'use strict'

const AJV = require('ajv')
const aws = require('aws-sdk') // eslint-disable-line import/no-unresolved, import/no-extraneous-dependencies

// TODO Get these from a better place later
const contributionRequestSchema = require('./contributions-request-schema.json')
const contributionItemsSchema = require('./contribution-items-schema.json')
const scoresRequestSchema = require('./scores-request-schema.json')
const scoreItemsSchema = require('./score-items-schema.json')
const popularityRequestSchema = require('./popularity-request-schema.json')
const popularityItemsSchema = require('./popularity-items-schema.json')

// TODO generalize this?  it is used by but not specific to this module
const makeSchemaId = schema => `${schema.self.vendor}/${schema.self.name}/${schema.self.version}`

const contributionRequestSchemaId = makeSchemaId(contributionRequestSchema)
const contributionItemsSchemaId = makeSchemaId(contributionItemsSchema)
const scoresRequestSchemaId = makeSchemaId(scoresRequestSchema)
const scoreItemsSchemaId = makeSchemaId(scoreItemsSchema)
const popularityRequestSchemaId = makeSchemaId(popularityRequestSchema)
const popularityItemsSchemaId = makeSchemaId(popularityItemsSchema)

const ajv = new AJV()
ajv.addSchema(contributionRequestSchema, contributionRequestSchemaId)
ajv.addSchema(contributionItemsSchema, contributionItemsSchemaId)
ajv.addSchema(scoresRequestSchema, scoresRequestSchemaId)
ajv.addSchema(scoreItemsSchema, scoreItemsSchemaId)
ajv.addSchema(popularityRequestSchema, popularityRequestSchemaId)
ajv.addSchema(popularityItemsSchema, popularityItemsSchemaId)

const dynamo = new aws.DynamoDB.DocumentClient()

const constants = {
  // self
  MODULE: 'winner-api/winnerApi.js',
  // methods
  METHOD_CONTRIBUTIONS: 'contributions',
  METHOD_SCORES: 'scores',
  METHOD_POPULARITY: 'popularity',
  // resources
  TABLE_CONTRIBUTIONS_NAME: process.env.TABLE_CONTRIBUTIONS_NAME,
  TABLE_SCORES_NAME: process.env.TABLE_SCORES_NAME,
  TABLE_POPULARITY_NAME: process.env.TABLE_POPULARITY_NAME,
  //
  INVALID_REQUEST: 'Invalid Request',
  INTEGRATION_ERROR: 'Integration Error',
  HASHES: '##########################################################################################',
  SECURITY_RISK: '!!!SECURITY RISK!!!',
  DATA_CORRUPTION: 'DATA CORRUPTION',
}

const impl = {
  response: (statusCode, body) => ({
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*', // Required for CORS support to work
      'Access-Control-Allow-Credentials': true, // Required for cookies, authorization headers with HTTPS
    },
    body,
  }),
  clientError: (method, schemaId, ajvErrors, event) => impl.response(
    400,
    `${method} ${constants.INVALID_REQUEST} could not validate request to '${schemaId}' schema. Errors: '${ajvErrors}' found in event: '${JSON.stringify(event)}'`),
  dynamoError: (method, err) => {
    console.log(err)
    return impl.response(500, `${method} - ${constants.INTEGRATION_ERROR}`)
  },
  securityRisk: (method, schemaId, ajvErrors, items) => {
    console.log(constants.HASHES)
    console.log(constants.SECURITY_RISK)
    console.log(`${method} ${constants.DATA_CORRUPTION} could not validate data to '${schemaId}' schema. Errors: ${ajvErrors}`)
    console.log(`${method} ${constants.DATA_CORRUPTION} bad data: ${JSON.stringify(items)}`)
    console.log(constants.HASHES)
    return impl.response(500, `${method} - ${constants.INTEGRATION_ERROR}`)
  },
  success: items => impl.response(200, JSON.stringify(items)),
  /**
   * Determine the source of the event from the origin, which is of format widget/role/uniqueId/friendlyName.
   * @param event The event to validate and process with the appropriate logic
   */
  eventSource: (origin) => {
    const parts = origin.split('/')
    if (parts.length > 2) {
      return {
        uniqueId: parts[2],
        friendlyName: parts.length === 3 ? parts[2] : parts[3],
      }
    } else if (parts.length === 2) {
      return {
        uniqueId: parts[1],
        friendlyName: parts[1],
      }
    } else {
      return {
        uniqueId: 'UNKNOWN',
        friendlyName: 'UNKNOWN',
      }
    }
  },
  extractor: (item) => {
    const extract = impl.eventSource(item.userId)
    // displays nothing if shorter than length 5; display at most three characters if longer than length 6
    // TODO find more coherent PII strategy than this
    let masked = extract.uniqueId.substring(extract.uniqueId.length - 7, extract.uniqueId.length - 4)
    if (masked.length > 0) {
      masked = ` (**...**${masked}****)`
    }
    return {
      userId: `${extract.friendlyName}${masked}`,
      score: item.score,
    }
  },
  best: (role, items) => {
    if (!items || items.length === 0 || items[0].score === 0) {
      return impl.success(`Not one ${role} found to have sold anything.`)
    } else {
      return impl.success(items.map(impl.extractor))
    }
  },
}
const api = {
  // TODO do something with this, other than getting all product ids with contributor info
  contributions: (event, context, callback) => {
    if (!ajv.validate(contributionRequestSchemaId, event)) { // bad request
      callback(null, impl.clientError(constants.METHOD_CONTRIBUTIONS, contributionRequestSchemaId, ajv.errorsText()), event)
    } else {
      const params = {
        TableName: constants.TABLE_CONTRIBUTIONS_NAME,
        AttributesToGet: ['productId'],
      }
      dynamo.scan(params, (err, data) => {
        if (err) { // error from dynamo
          callback(null, impl.dynamoError(constants.METHOD_CONTRIBUTIONS, err))
        } else if (!ajv.validate(contributionItemsSchemaId, data.Items)) { // bad data in dynamo
          callback(null, impl.securityRisk(constants.METHOD_CONTRIBUTIONS, contributionItemsSchemaId, ajv.errorsText()), data.Items) // careful if the data is sensitive
        } else { // valid
          callback(null, impl.success(data.Items))
        }
      })
    }
  },
  scores: (event, context, callback) => {
    if (!ajv.validate(scoresRequestSchemaId, event)) { // bad request
      callback(null, impl.clientError(constants.METHOD_SCORES, scoresRequestSchemaId, ajv.errorsText()), event)
    } else {
      const params = {
        TableName: constants.TABLE_SCORES_NAME,
        IndexName: 'ScoresByRole',
        ProjectionExpression: '#i, #s',
        KeyConditionExpression: '#r = :r',
        ExpressionAttributeNames: {
          '#i': 'userId',
          '#r': 'role',
          '#s': 'score',
        },
        ExpressionAttributeValues: {
          ':r': event.queryStringParameters.role,
        },
        ScanIndexForward: false,
        Limit: event.queryStringParameters.limit ? event.queryStringParameters.limit : 1,
      }

      dynamo.query(params, (err, data) => {
        if (err) { // error from dynamo
          callback(null, impl.dynamoError(constants.METHOD_SCORES, err))
        } else if (!ajv.validate(scoreItemsSchemaId, data.Items)) { // bad data in dynamo
          callback(null, impl.securityRisk(constants.METHOD_SCORES, scoreItemsSchemaId, ajv.errorsText()), data.Items) // careful if the data is sensitive
        } else { // valid
          callback(null, impl.best(event.queryStringParameters.role, data.Items))
        }
      })
    }
  },
  popularity: (event, context, callback) => {
  if (!ajv.validate(popularityRequestSchemaId, event)) { // bad request
    callback(null, impl.clientError(constants.METHOD_POPULARITY, popularityRequestSchemaId, ajv.errorsText()), event)
  } else {
    const params = {
      TableName: constants.TABLE_POPULARITY_NAME,
      IndexName: 'ProductsByCount',
      ProjectionExpression: '#pn, #pc',
      KeyConditionExpression: '#ty = :ty',
      ExpressionAttributeNames: {
        '#ty': 'type',
        '#pc': 'purchaseCount',
        '#pn': 'productName'
      },
      ExpressionAttributeValues: {
        ':ty': 'product'  //arbitrary hash value which is the same for each entry so we can effectively scan the index
      },
      Limit: 3,
      ScanIndexForward: false, // scans the table backwards, first returning highest values of count
      ConsistentRead: false,
    }

    dynamo.query(params, (err, data) => {
      if (err) { // error from dynamo
        callback(null, impl.dynamoError(constants.METHOD_POPULARITY, err))
      } else if (!ajv.validate(popularityItemsSchemaId, data.Items)) { // bad data in dynamo
        callback(null, impl.securityRisk(constants.METHOD_POPULARITY, popularityItemsSchemaId, ajv.errorsText()), data.Items) // careful if the data is sensitive
      } else { // valid
        callback(null, impl.success(data.Items))
      }
    })
  }
},
}

module.exports = {
  contributions: api.contributions,
  scores: api.scores,
  popularity: api.popularity,
}
