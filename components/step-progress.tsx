interface StepProgressProps {
  currentStep: 1 | 2 | 3
  completedSteps: number[]
}

const steps = [
  'Connect Stripe',
  'Paste changelog',
  'Review first email',
]

export function StepProgress({ currentStep, completedSteps }: StepProgressProps) {
  return (
    <div className="flex items-center bg-white rounded-2xl border border-slate-100 p-2 gap-1 max-w-2xl w-full">
      {steps.map((name, i) => {
        const stepNum = i + 1
        const isCompleted = completedSteps.includes(stepNum)
        const isActive = stepNum === currentStep

        return (
          <div
            key={stepNum}
            className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl flex-1 ${
              isActive ? 'bg-blue-50' : ''
            }`}
          >
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                isCompleted
                  ? 'bg-green-100 text-green-600'
                  : isActive
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-400'
              }`}
            >
              {isCompleted ? '✓' : stepNum}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                Step {stepNum}
              </div>
              <div
                className={`text-xs font-semibold truncate ${
                  isActive ? 'text-slate-900' : 'text-slate-400'
                }`}
              >
                {name}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
