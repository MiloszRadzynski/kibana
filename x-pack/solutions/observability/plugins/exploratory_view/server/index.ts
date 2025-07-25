/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type PluginConfigDescriptor, PluginInitializerContext } from '@kbn/core/server';
import { schema } from '@kbn/config-schema';

export const plugin = async (initializerContext: PluginInitializerContext) => {
  const { Plugin } = await import('./plugin');
  return new Plugin();
};

export const config: PluginConfigDescriptor = {
  schema: schema.object({
    enabled: schema.boolean({ defaultValue: true }),
  }),
};
