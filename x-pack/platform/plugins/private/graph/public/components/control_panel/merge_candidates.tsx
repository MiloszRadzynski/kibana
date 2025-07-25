/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { i18n } from '@kbn/i18n';
import {
  EuiButtonIcon,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiToolTip,
  type UseEuiTheme,
} from '@elastic/eui';
import { css } from '@emotion/react';
import { ControlType, TermIntersect, Workspace } from '../../types';
import { VennDiagram } from '../venn_diagram';
import { gphSidebarHeaderStyles, gphSidebarPanelStyles } from '../../styles';

interface MergeCandidatesProps {
  workspace: Workspace;
  mergeCandidates: TermIntersect[];
  onSetControl: (control: ControlType) => void;
}

export const MergeCandidates = ({
  workspace,
  mergeCandidates,
  onSetControl,
}: MergeCandidatesProps) => {
  const performMerge = (parentId: string, childId: string) => {
    const tempMergeCandidates = [...mergeCandidates];
    let found = true;
    while (found) {
      found = false;

      for (let i = 0; i < tempMergeCandidates.length; i++) {
        const term = tempMergeCandidates[i];
        if (term.id1 === childId || term.id2 === childId) {
          tempMergeCandidates.splice(i, 1);
          found = true;
          break;
        }
      }
    }
    workspace.mergeIds(parentId, childId);
    onSetControl('none');
  };

  return (
    <div css={gphSidebarPanelStyles}>
      <div css={gphSidebarHeaderStyles}>
        <EuiIcon type="link" />{' '}
        {i18n.translate('xpack.graph.sidebar.linkSummaryTitle', {
          defaultMessage: 'Link summary',
        })}
      </div>
      {mergeCandidates.length === 0 && (
        <EuiFlexGroup alignItems="center" style={{ minHeight: 101 }}>
          <EuiFlexItem component="span">
            {i18n.translate('xpack.graph.sidebar.linkSummary.noData', {
              defaultMessage: 'No terms intersection found for the link selection.',
            })}
          </EuiFlexItem>
        </EuiFlexGroup>
      )}
      {mergeCandidates.map((mc) => {
        const mergeTerm1ToTerm2ButtonMsg = i18n.translate(
          'xpack.graph.sidebar.linkSummary.mergeTerm1ToTerm2ButtonTooltip',
          {
            defaultMessage: 'Merge {term1} into {term2}',
            values: { term1: mc.term1, term2: mc.term2 },
          }
        );
        const mergeTerm2ToTerm1ButtonMsg = i18n.translate(
          'xpack.graph.sidebar.linkSummary.mergeTerm2ToTerm1ButtonTooltip',
          {
            defaultMessage: 'Merge {term2} into {term1}',
            values: { term1: mc.term1, term2: mc.term2 },
          }
        );
        const leftTermCountMsg = i18n.translate(
          'xpack.graph.sidebar.linkSummary.leftTermCountTooltip',
          {
            defaultMessage: '{count} documents have term {term}',
            values: { count: mc.v1, term: mc.term1 },
          }
        );
        const bothTermsCountMsg = i18n.translate(
          'xpack.graph.sidebar.linkSummary.bothTermsCountTooltip',
          {
            defaultMessage: '{count} documents have both terms',
            values: { count: mc.overlap },
          }
        );
        const rightTermCountMsg = i18n.translate(
          'xpack.graph.sidebar.linkSummary.rightTermCountTooltip',
          {
            defaultMessage: '{count} documents have term {term}',
            values: { count: mc.v2, term: mc.term2 },
          }
        );

        const onMergeTerm1ToTerm2Click = () => performMerge(mc.id2, mc.id1);
        const onMergeTerm2ToTerm1Click = () => performMerge(mc.id1, mc.id2);

        return (
          <div>
            <span>
              <EuiToolTip content={mergeTerm1ToTerm2ButtonMsg} disableScreenReaderOutput>
                <EuiButtonIcon
                  iconType="doubleArrowRight"
                  size="xs"
                  style={{ opacity: 0.2 + mc.overlap / mc.v1 }}
                  aria-label={mergeTerm1ToTerm2ButtonMsg}
                  onClick={onMergeTerm1ToTerm2Click}
                />
              </EuiToolTip>

              <span className="gphLinkSummary__term--1" css={styles.term1}>
                {mc.term1}
              </span>
              <span className="gphLinkSummary__term--2" css={styles.term2}>
                {mc.term2}
              </span>

              <EuiToolTip content={mergeTerm2ToTerm1ButtonMsg} disableScreenReaderOutput>
                <EuiButtonIcon
                  iconType="doubleArrowLeft"
                  size="xs"
                  style={{ opacity: 0.2 + mc.overlap / mc.v2 }}
                  aria-label={mergeTerm2ToTerm1ButtonMsg}
                  onClick={onMergeTerm2ToTerm1Click}
                />
              </EuiToolTip>
            </span>

            <VennDiagram leftValue={mc.v1} rightValue={mc.v2} overlap={mc.overlap} />

            <EuiToolTip content={leftTermCountMsg}>
              <small className="gphLinkSummary__term--1" css={styles.term1}>
                {mc.v1}
              </small>
            </EuiToolTip>
            <EuiToolTip content={bothTermsCountMsg}>
              <small className="gphLinkSummary__term--1-2" css={styles.term1_2}>
                &nbsp;({mc.overlap})&nbsp;
              </small>
            </EuiToolTip>
            <EuiToolTip content={rightTermCountMsg}>
              <small className="gphLinkSummary__term--2" css={styles.term2}>
                {mc.v2}
              </small>
            </EuiToolTip>
          </div>
        );
      })}
    </div>
  );
};

const styles = {
  term1: ({ euiTheme }: UseEuiTheme) =>
    css({
      color: euiTheme.colors.danger,
    }),

  term2: ({ euiTheme }: UseEuiTheme) =>
    css({
      color: euiTheme.colors.primary,
    }),

  term1_2: ({ euiTheme }: UseEuiTheme) => css`
    color: color-mix(in srgb, ${euiTheme.colors.danger}, ${euiTheme.colors.primary});
  `,
};
