package internalmessaging

// Module keeps the optional in-app direct-message feature isolated from the
// rest of the HTTP surface.
type Module struct{ Handler *Handler }

func NewModule(handler *Handler) *Module { return &Module{Handler: handler} }
