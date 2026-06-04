import { useEffect, useMemo, useState } from 'react'
import type { ArticleScript } from '../domain/types'
import {
  createArticleScript,
  measureArticleScript,
  measureCombinedScriptSeconds,
  resolveArticleDurationSeconds,
} from '../domain/articleDuration'
import {
  getCombinedManuscript,
  scriptFromCombinedManuscript,
  scriptFromSplit,
  splitManuscript,
} from '../domain/articleScript'
import { formatSeconds, parseTimeToSeconds } from '../domain/time'

type InputMode = 'combined' | 'split'

type Props = {
  itemTitle: string
  initial: ArticleScript | undefined
  disabled?: boolean
  onClose: () => void
  onApply: (article: ArticleScript, durationSeconds: number) => void
}

export function ArticleEditorModal(props: Props) {
  const [script, setScript] = useState<ArticleScript>(() =>
    props.initial ? { ...createArticleScript(), ...props.initial } : createArticleScript(),
  )
  const [inputMode, setInputMode] = useState<InputMode>(() => {
    if (!props.initial) return 'combined'
    if (props.initial.anchorText.trim() && props.initial.bodyText.trim()) return 'split'
    return 'combined'
  })
  const [combinedDraft, setCombinedDraft] = useState(() => getCombinedManuscript(script))
  const [durationDraft, setDurationDraft] = useState(() => {
    const pref = props.initial?.preferredDurationSeconds
    if (typeof pref === 'number' && pref >= 0) return formatSeconds(pref)
    return ''
  })

  useEffect(() => {
    const next = props.initial ? { ...createArticleScript(), ...props.initial } : createArticleScript()
    setScript(next)
    setCombinedDraft(getCombinedManuscript(next))
    const pref = next.preferredDurationSeconds
    setDurationDraft(typeof pref === 'number' && pref >= 0 ? formatSeconds(pref) : '')
    if (next.anchorText.trim() && next.bodyText.trim()) setInputMode('split')
    else setInputMode('combined')
  }, [props.initial, props.itemTitle])

  const measuredAuto = useMemo(() => {
    if (inputMode === 'combined') {
      const sec = measureCombinedScriptSeconds(scriptFromCombinedManuscript(combinedDraft, script))
      return { anchorSeconds: 0, bodySeconds: sec, currentSeconds: sec }
    }
    return measureArticleScript(script)
  }, [inputMode, combinedDraft, script])

  const appliedSeconds = useMemo(() => {
    const parsed = parseTimeToSeconds(durationDraft.trim())
    if (parsed != null) return parsed
    return measuredAuto.currentSeconds
  }, [durationDraft, measuredAuto.currentSeconds])

  const baseline = script.baselineSeconds
  const delta = baseline > 0 ? baseline - appliedSeconds : 0
  const usingManualDuration = parseTimeToSeconds(durationDraft.trim()) != null

  function patch(partial: Partial<ArticleScript>) {
    setScript((prev) => ({ ...prev, ...partial }))
  }

  function switchToCombined() {
    setCombinedDraft(getCombinedManuscript(script))
    setInputMode('combined')
    setScript((prev) => scriptFromCombinedManuscript(getCombinedManuscript(prev), prev))
  }

  function switchToSplit() {
    const { anchorText, bodyText } = splitManuscript(combinedDraft || getCombinedManuscript(script))
    setInputMode('split')
    setScript((prev) => scriptFromSplit(anchorText, bodyText, prev))
  }

  function handleApply() {
    let finalScript: ArticleScript =
      inputMode === 'combined'
        ? scriptFromCombinedManuscript(combinedDraft, script)
        : script

    const manualSec = parseTimeToSeconds(durationDraft.trim())
    if (manualSec != null) {
      finalScript = { ...finalScript, preferredDurationSeconds: manualSec }
    } else {
      finalScript = { ...finalScript, preferredDurationSeconds: null }
    }

    const autoSec = measureArticleScript(finalScript).currentSeconds
    if (finalScript.baselineSeconds <= 0 && autoSec > 0) {
      finalScript = { ...finalScript, baselineSeconds: autoSec }
    }

    const durationSeconds = resolveArticleDurationSeconds(finalScript)
    props.onApply(finalScript, durationSeconds)
    props.onClose()
  }

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={props.onClose}>
      <div
        className="modalCard articleModal"
        role="dialog"
        aria-labelledby="article-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modalHeader">
          <div>
            <div id="article-modal-title" className="modalTitle">
              큐시트 · 원고 입력
            </div>
            <div className="modalSub muted">{props.itemTitle || '(제목 없음)'}</div>
          </div>
          <button type="button" className="btn subtle" onClick={props.onClose}>
            닫기
          </button>
        </div>

        <div className="articleModeTabs">
          <button
            type="button"
            className={`articleModeTab ${inputMode === 'combined' ? 'active' : ''}`}
            disabled={props.disabled}
            onClick={() => {
              if (inputMode === 'split') {
                setCombinedDraft(getCombinedManuscript(script))
                setScript(scriptFromCombinedManuscript(getCombinedManuscript(script), script))
              }
              setInputMode('combined')
            }}
          >
            한 덩어리
          </button>
          <button
            type="button"
            className={`articleModeTab ${inputMode === 'split' ? 'active' : ''}`}
            disabled={props.disabled}
            onClick={switchToSplit}
          >
            앵커 / 기사 분리
          </button>
        </div>

        <div className="articleMetrics">
          <span className="tag mono">
            자동 측정 <strong>{formatSeconds(measuredAuto.currentSeconds)}</strong>
          </span>
          <span className="tag mono">
            반영 길이 <strong>{formatSeconds(appliedSeconds)}</strong>
            {usingManualDuration ? ' (직접)' : ''}
          </span>
          {baseline > 0 ? (
            <span className={`tag mono ${delta > 0 ? 'ok' : ''}`}>
              원본 대비 {delta > 0 ? `−${formatSeconds(delta)}` : delta < 0 ? `+${formatSeconds(-delta)}` : '±00:00'}
            </span>
          ) : null}
        </div>

        <label className="articleField">
          <span className="articleFieldHead">
            <span>큐시트 길이 (mm:ss)</span>
            <span className="muted" style={{ fontWeight: 400 }}>
              비우면 자동 측정값
            </span>
          </span>
          <input
            className="input mono"
            placeholder={formatSeconds(measuredAuto.currentSeconds)}
            value={durationDraft}
            disabled={props.disabled}
            onChange={(e) => setDurationDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>

        {inputMode === 'combined' ? (
          <label className="articleField">
            <span className="articleFieldHead">
              <span>원고 (앵커+기사)</span>
              <button
                type="button"
                className="btn subtle articleMiniBtn"
                disabled={props.disabled || !combinedDraft.trim()}
                onClick={() => {
                  const { anchorText, bodyText } = splitManuscript(combinedDraft)
                  setScript((prev) => scriptFromSplit(anchorText, bodyText, prev))
                  setInputMode('split')
                }}
              >
                --- 로 나누기
              </button>
            </span>
            <textarea
              className="articleTextarea articleTextareaBody"
              placeholder="단락 없이 붙여 넣어도 됩니다. 앵커와 기사를 나누려면 중간에 --- 를 넣거나 「앵커/기사 분리」를 사용하세요."
              value={combinedDraft}
              disabled={props.disabled}
              onChange={(e) => {
                const v = e.target.value
                setCombinedDraft(v)
                setScript((prev) => scriptFromCombinedManuscript(v, prev))
              }}
            />
          </label>
        ) : (
          <>
            <label className="articleField">
              <span className="articleFieldHead">
                <span>앵커멘트</span>
                <label className="articleInclude">
                  <input
                    type="checkbox"
                    checked={script.anchorIncluded}
                    disabled={props.disabled}
                    onChange={(e) => patch({ anchorIncluded: e.target.checked })}
                  />
                  포함
                </label>
              </span>
              <textarea
                className="articleTextarea"
                placeholder="앵커 멘트…"
                value={script.anchorText}
                disabled={props.disabled}
                onChange={(e) => patch({ anchorText: e.target.value })}
              />
            </label>
            <label className="articleField">
              <span className="articleFieldHead">
                <span>기사 내용</span>
                <label className="articleInclude">
                  <input
                    type="checkbox"
                    checked={script.bodyIncluded}
                    disabled={props.disabled}
                    onChange={(e) => patch({ bodyIncluded: e.target.checked })}
                  />
                  포함
                </label>
              </span>
              <textarea
                className="articleTextarea articleTextareaBody"
                placeholder="기사 본문…"
                value={script.bodyText}
                disabled={props.disabled}
                onChange={(e) => patch({ bodyText: e.target.value })}
              />
            </label>
            <button type="button" className="btn subtle" disabled={props.disabled} onClick={switchToCombined}>
              한 덩어리로 합치기
            </button>
          </>
        )}

        <p className="hint articleHint">
          길이 정확도는 추후 조정 예정입니다. 지금은 <strong>큐시트 길이</strong>에 01:59처럼 직접 입력하면 그 값이
          행에 반영되고, 비우면 자동 측정값이 사용됩니다.
        </p>

        <div className="modalActions">
          <button type="button" className="btn subtle" onClick={props.onClose}>
            취소
          </button>
          <button type="button" className="btn" disabled={props.disabled} onClick={handleApply}>
            큐시트에 반영 ({formatSeconds(appliedSeconds)})
          </button>
        </div>
      </div>
    </div>
  )
}
