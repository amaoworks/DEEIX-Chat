package internalmessaging

import "github.com/gin-gonic/gin"

func (m *Module) RegisterRoutes(authRequired *gin.RouterGroup) {
	group := authRequired.Group("/internal-messaging")
	group.GET("/status", m.Handler.Status)
	group.GET("/users", m.Handler.ListUsers)
	group.GET("/users/:publicID/messages", m.Handler.History)
	group.POST("/users/:publicID/messages", m.Handler.Send)
	group.GET("/events", m.Handler.Events)
}
