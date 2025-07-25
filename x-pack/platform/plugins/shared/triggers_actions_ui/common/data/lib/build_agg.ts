/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { AggregationsAggregationContainer } from '@elastic/elasticsearch/lib/api/types';
import type { DateRangeInfo } from './date_range_info';
import { getDateRangeInfo } from './date_range_info';

export interface BuildAggregationOpts {
  timeSeries?: {
    timeField: string;
    dateStart?: string;
    dateEnd?: string;
    interval?: string;
    timeWindowSize: number;
    timeWindowUnit: string;
  };
  aggType: string;
  aggField?: string;
  termSize?: number;
  termField?: string | string[];
  sourceFieldsParams?: Array<{ label: string; searchPath: string }>;
  topHitsSize?: number;
  condition?: {
    resultLimit?: number;
    conditionScript: string;
  };
  loggerCb?: (message: string) => void;
}

const BUCKET_SELECTOR_PATH_NAME = 'compareValue';
export const BUCKET_SELECTOR_FIELD = `params.${BUCKET_SELECTOR_PATH_NAME}`;
export const DEFAULT_GROUPS = 100;
const MAX_SOURCE_FIELDS_TO_COPY = 10;

const MAX_TOP_HITS_SIZE = 100;

export const isCountAggregation = (aggType: string) => aggType === 'count';
export const isGroupAggregation = (termField?: string | string[]) => !!termField;
export const isPerRowAggregation = (groupBy?: string) => groupBy === 'row';

export const buildAggregation = ({
  timeSeries,
  aggType,
  aggField,
  termField,
  termSize,
  sourceFieldsParams,
  condition,
  topHitsSize,
  loggerCb,
}: BuildAggregationOpts): Record<string, AggregationsAggregationContainer> => {
  const aggContainer: AggregationsAggregationContainer = {
    aggs: {},
  };
  const isCountAgg = isCountAggregation(aggType);
  const isGroupAgg = isGroupAggregation(termField);
  const isMultiTerms = Array.isArray(termField);
  const isDateAgg = !!timeSeries;
  const includeConditionInQuery = !!condition;

  let dateRangeInfo: DateRangeInfo | null = null;
  if (isDateAgg) {
    const { timeWindowSize, timeWindowUnit, dateStart, dateEnd, interval } = timeSeries;
    const window = `${timeWindowSize}${timeWindowUnit}`;
    dateRangeInfo = getDateRangeInfo({ dateStart, dateEnd, window, interval });
  }

  // Cap the maximum number of terms returned to the resultLimit if defined
  // Use resultLimit + 1 because we're using the bucket selector aggregation
  // to apply the threshold condition to the ES query. We don't seem to be
  // able to get the true cardinality from the bucket selector (i.e., get
  // the number of buckets that matched the selector condition without actually
  // retrieving the bucket data). By using resultLimit + 1, we can count the number
  // of buckets returned and if the value is greater than resultLimit, we know that
  // there is additional alert data that we're not returning.
  let terms = termSize || DEFAULT_GROUPS;
  terms =
    includeConditionInQuery && condition.resultLimit
      ? terms > condition.resultLimit
        ? condition.resultLimit + 1
        : terms
      : terms;

  let aggParent: AggregationsAggregationContainer = aggContainer;

  const getAggName = () => (isDateAgg ? 'sortValueAgg' : 'metricAgg');

  // first, add a group aggregation, if requested
  if (isGroupAgg) {
    aggParent.aggs = {
      groupAgg: {
        ...(isMultiTerms
          ? {
              multi_terms: {
                terms: termField.map((field) => ({ field })),
                size: terms,
              },
            }
          : {
              terms: {
                field: termField,
                size: terms,
              },
            }),
      },
      ...(includeConditionInQuery
        ? {
            groupAggCount: {
              stats_bucket: {
                buckets_path: 'groupAgg._count',
              },
            },
          }
        : {}),
    };

    // if not count add an order
    if (!isCountAgg) {
      const sortOrder = aggType === 'min' ? 'asc' : 'desc';
      if (isMultiTerms && aggParent.aggs.groupAgg.multi_terms) {
        aggParent.aggs.groupAgg.multi_terms.order = {
          [getAggName()]: sortOrder,
        };
      } else if (aggParent.aggs.groupAgg.terms) {
        aggParent.aggs.groupAgg.terms.order = {
          [getAggName()]: sortOrder,
        };
      }
    } else if (includeConditionInQuery) {
      aggParent.aggs.groupAgg.aggs = {
        conditionSelector: {
          bucket_selector: {
            buckets_path: {
              [BUCKET_SELECTOR_PATH_NAME]: '_count',
            },
            script: condition.conditionScript,
          },
        },
      };
    }
    aggParent = aggParent.aggs.groupAgg;
  }

  // add sourceField aggregations
  if (sourceFieldsParams && sourceFieldsParams.length > 0) {
    sourceFieldsParams.forEach((field) => {
      aggParent.aggs = {
        ...aggParent.aggs,
        [field.label]: {
          terms: { field: field.searchPath, size: MAX_SOURCE_FIELDS_TO_COPY },
        },
      };
    });
  }

  // next, add the time window aggregation
  if (isDateAgg) {
    aggParent.aggs = {
      ...aggParent.aggs,
      dateAgg: {
        date_range: {
          field: timeSeries.timeField,
          format: 'strict_date_time',
          ranges: dateRangeInfo!.dateRanges,
        },
      },
    };
  }

  if (isGroupAgg && topHitsSize) {
    if (topHitsSize > MAX_TOP_HITS_SIZE) {
      topHitsSize = MAX_TOP_HITS_SIZE;
      if (loggerCb) loggerCb(`Top hits size is capped at ${MAX_TOP_HITS_SIZE}`);
    }

    aggParent.aggs = {
      ...aggParent.aggs,
      topHitsAgg: {
        top_hits: {
          size: topHitsSize,
        },
      },
    };
  }

  // if not count, add a sorted value agg
  if (!isCountAgg) {
    aggParent.aggs = {
      ...aggParent.aggs,
      [getAggName()]: {
        [aggType]: {
          field: aggField,
        },
      },
    };

    if (isGroupAgg && includeConditionInQuery) {
      aggParent.aggs.conditionSelector = {
        bucket_selector: {
          buckets_path: {
            [BUCKET_SELECTOR_PATH_NAME]: getAggName(),
          },
          script: condition.conditionScript,
        },
      };
    }
  }

  if (timeSeries && dateRangeInfo) {
    aggParent = aggParent?.aggs?.dateAgg ?? {};

    // finally, the metric aggregation, if requested
    if (!isCountAgg) {
      aggParent.aggs = {
        metricAgg: {
          [aggType]: {
            field: aggField,
          },
        },
      };
    }
  }

  return aggContainer.aggs ?? {};
};
