package smoke

import "context"

type Worker struct {
	Name string
}

func (w Worker) Run(ctx context.Context) error {
	return nil
}

func NewWorker(name string) Worker {
	return Worker{Name: name}
}

var DefaultWorker = Worker{Name: "default"}
